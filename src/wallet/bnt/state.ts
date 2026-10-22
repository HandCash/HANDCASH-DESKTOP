import { storageRegistry } from '../../storage/registry'
import { accountLocalKey } from '../accountLocalKeys'
import { durableGetItem, durableSetItem } from '../durableStorage'

/**
 * Account-scoped BRC-255 state: packages waiting for a recipient's box and
 * the transactions each peer is known to hold, so a package to that peer
 * stops there (§6). Chain facts live in `store.ts`.
 */

/** One output's remittance as the recipient reads it: it derives the holder key from these and the sender. */
export type BntDeliveryOutput = { vout: number; derivationPrefix: string; derivationSuffix: string }

export type BntOutboxEntry = {
  recipient: string
  assetId: string
  txid: string
  outputs: BntDeliveryOutput[]
  at: number
  attempts: number
  nextAt: number
  lastError?: string
}

export type BntState = {
  outbox: Record<string, BntOutboxEntry>
  /** peer identity → asset id → txids that peer holds. */
  frontier: Record<string, Record<string, string[]>>
  /** asset id → the newest open mint (`txid.vout`) this wallet knows; the chain may have moved past it. */
  mints?: Record<string, string>
}

const MAX_FRONTIER = 256

function key(): string {
  return accountLocalKey(storageRegistry.bnt.key)
}

export function readBntState(): BntState {
  try {
    const parsed = JSON.parse(durableGetItem(key()) ?? '{}') as Partial<BntState>
    return { outbox: parsed.outbox ?? {}, frontier: parsed.frontier ?? {}, ...(parsed.mints ? { mints: parsed.mints } : {}) }
  } catch {
    return { outbox: {}, frontier: {} }
  }
}

export function writeBntState(state: BntState): void {
  if (!durableSetItem(key(), JSON.stringify(state))) {
    throw new Error('The BNT record could not be saved.')
  }
}

export function outboxId(recipient: string, txid: string): string {
  return `${recipient.toLowerCase()}:${txid.toLowerCase()}`
}

export function peerHolds(state: BntState, peer: string, assetId: string): Set<string> {
  return new Set(state.frontier[peer.toLowerCase()]?.[assetId] ?? [])
}

/** Newest last; the oldest fall off, so a package only grows back to what the peer may have pruned. */
export function notePeerHolds(state: BntState, peer: string, assetId: string, txids: readonly string[]): void {
  const who = peer.toLowerCase()
  const byAsset = (state.frontier[who] ??= {})
  const list = (byAsset[assetId] ?? []).filter((t) => !txids.includes(t))
  byAsset[assetId] = [...list, ...txids].slice(-MAX_FRONTIER)
}
