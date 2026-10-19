import { storageRegistry } from '../../storage/registry'
import { accountLocalKey } from '../accountLocalKeys'
import { durableGetItem, durableSetItem } from '../durableStorage'
import type { SelfRemittance } from './legChains'
import type { SignedSwapOffer } from './offer'
import type { SwapSettlePhase } from '../../machines/swapSettleMachine'
import type { SettleOutcome, SettleWait, SwapRole, SwapTerms } from './settle'

/**
 * The account's wallet-to-wallet swaps and the offers it published. Durable
 * and written before every step that moves coins, so a restart picks a swap
 * up where it was; the custody journal carries each lock off the device.
 */

/** One BSV refund the counterparty co-signs before the lock is broadcast. */
export type BsvRefund = { vout: number; to: string; value: string; remittance: SelfRemittance; cosig?: string }

export type OwnLeg = {
  /** BSV: the signed lock, not broadcast until its refunds are co-signed. */
  prepared?: { txid: string; beef: string }
  refunds?: BsvRefund[]
  presignAskedAt?: number
  /** Coin chains: funding started; the coin wallet's payment marked with this swap carries the txid. */
  funding?: { txid: string; main: number; fee?: number }
  fundingStartedAt?: number
  fundedSentAt?: number
  refund?: { txid: string; hex: string }
  refunded?: true
  feeRefund?: { txid: string; hex: string }
  /** HandCash claimed the fee output, or its payer took it back. */
  feeSettled?: 'claimed' | 'refunded'
}

export type PeerLeg = {
  funding?: { txid: string; main: number; fee?: number; beef?: string }
  /** The announced lock does not match the terms; never claimed, never waited on. */
  refused?: string
  buried?: true
  confirmations?: { have: number; need: number }
  claim?: { txid: string; hex: string }
  claimed?: true
  refunded?: true
}

export type SettleRecord = {
  v: 1
  role: SwapRole
  counterparty: string
  terms: SwapTerms
  makerPub?: string
  accepted?: true
  declined?: string
  /** Maker: the secret, once the taker's claim (or courtesy message) shows it. */
  secret?: string
  own: OwnLeg
  peer: PeerLeg
  /** Where `swapSettleMachine` stands; restored each pass. */
  phase?: SwapSettlePhase
  /** What the swap waits on now, for the UI. */
  waiting?: { for: SettleWait; until?: number }
  outcome?: SettleOutcome
  /** HandCash's fee claimer has the fee leg's lock. */
  feeReportedAt?: number
  lastError?: string
  createdAt: number
  updatedAt: number
}

export type PublishedOffer = { offer: SignedSwapOffer; state: 'open' | 'taken' | 'cancelled'; swapId?: string }

export type SettleState = { swaps: Record<string, SettleRecord>; offers: Record<string, PublishedOffer> }

const listeners = new Set<() => void>()
const key = () => accountLocalKey(storageRegistry.swapSettle.key)

export function readSettleState(): SettleState {
  try {
    const parsed = JSON.parse(durableGetItem(key()) ?? '{}') as Partial<SettleState>
    return { swaps: parsed.swaps ?? {}, offers: parsed.offers ?? {} }
  } catch {
    return { swaps: {}, offers: {} }
  }
}

export function writeSettleState(state: SettleState): void {
  const json = JSON.stringify(state)
  if (json === durableGetItem(key())) return
  if (!durableSetItem(key(), json)) throw new Error('The swap record could not be saved.')
  for (const listener of listeners) listener()
}

/** Change one swap in place; `null` from `edit` leaves the state alone. */
export function updateSwap(swapId: string, edit: (record: SettleRecord) => SettleRecord | null): SettleRecord | null {
  const state = readSettleState()
  const current = state.swaps[swapId]
  if (!current) return null
  const next = edit(structuredClone(current))
  if (!next) return current
  const { updatedAt: _was, ...a } = current
  const { updatedAt: _now, ...b } = next
  if (JSON.stringify(a) === JSON.stringify(b)) return current
  state.swaps[swapId] = { ...next, updatedAt: Date.now() }
  writeSettleState(state)
  return state.swaps[swapId]!
}

export function putSwap(record: SettleRecord): void {
  const state = readSettleState()
  state.swaps[record.terms.swapId] = record
  writeSettleState(state)
}

export function rememberPublishedOffer(offer: SignedSwapOffer): void {
  const state = readSettleState()
  state.offers[offer.nonce] = { offer, state: 'open' }
  writeSettleState(state)
}

export function markOfferCancelled(nonce: string): void {
  const state = readSettleState()
  const held = state.offers[nonce]
  if (!held) return
  held.state = 'cancelled'
  writeSettleState(state)
}

export function subscribeSettle(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The stored state as one string, stable between writes: a `useSyncExternalStore` snapshot. */
export const settleSnapshot = (): string => durableGetItem(key()) ?? ''

/** Swaps still moving, newest first. */
export function activeSwaps(state = readSettleState()): SettleRecord[] {
  return Object.values(state.swaps)
    .filter((r) => !r.outcome)
    .sort((a, b) => b.createdAt - a.createdAt)
}
