/**
 * Parity-oriented spend guard (cloud-inspired, local):
 * - serialize spends on this device (wallet coordinator spend region)
 * - advisory lease on shared backup URL across devices
 * - force chain heal before pay (nested chain ingest during spend)
 */
import { extractSatsFromArgs } from './appActivity'
import { assertOnlineForPayment } from './paymentPolicy'
import { fetchBalanceSats, getActiveWallet } from './session'
import { refreshFromChain, refreshFromChainDuringSpend } from './chainIngest'
import { acquireSpendLease } from './spendLease'
import {
  getWalletCoordinatorSnapshot,
  runExclusiveSpend as runExclusiveSpendCoordinated,
} from './walletCoordinator'

/** Run spend-related work one-at-a-time (selection + broadcast + cross-device lease). */
export function runExclusiveSpend<T>(
  fn: () => Promise<T>,
  onSpendRegion?: () => void,
): Promise<T> {
  return runExclusiveSpendCoordinated(fn, acquireSpendLease, onSpendRegion)
}

/**
 * Force chain refresh; return spendable sats.
 *
 * Pre-prompt heals (auto-pay silent path) run *outside* a spend session, so they
 * use the top-level chain ingest path. Heals under `runExclusiveSpend` nest via
 * `refreshFromChainDuringSpend`.
 *
 * A heal completed within FUNDING_HEAL_FRESH_MS is reused so auto-pay's pre-prompt
 * heal + post-approve heal do not double-scan the address.
 */
const FUNDING_HEAL_FRESH_MS = 5_000
let lastFundingHealAt = 0
let lastFundingHealSats: number | null = null

/** Call after a successful spend so the next heal cannot reuse pre-spend outs. */
export function invalidateFundingHealCache(): void {
  lastFundingHealAt = 0
  lastFundingHealSats = null
}

export async function refreshSpendableBalance(): Promise<number> {
  assertOnlineForPayment()
  const active = getActiveWallet()
  if (!active) throw new Error('Wallet locked')

  const now = Date.now()
  if (
    lastFundingHealSats != null &&
    now - lastFundingHealAt < FUNDING_HEAL_FRESH_MS
  ) {
    return lastFundingHealSats
  }

  // No audit: it only reports, and paying a request per output here is what made
  // sending feel frozen. fundingOnly for the same reason — a payment cannot spend
  // an ordinal, so identifying one mid-send is pure latency.
  const opts = { announceReceive: false, audit: false, fundingOnly: true } as const
  const synced =
    getWalletCoordinatorSnapshot().spend === 'active'
      ? await refreshFromChainDuringSpend(opts)
      : await refreshFromChain(opts)
  const sats = synced != null ? synced : await fetchBalanceSats(active.wallet)
  lastFundingHealAt = Date.now()
  lastFundingHealSats = sats
  return sats
}

/** Refresh from chain and ensure `satoshis` still fits. */
export async function assertSendableBalance(satoshis: number): Promise<number> {
  if (!Number.isFinite(satoshis) || satoshis <= 0) throw new Error('Invalid amount')
  const available = await refreshSpendableBalance()
  if (satoshis > available) {
    throw new Error(
      `Insufficient balance after refresh (${available} sats available, need ${satoshis}).`,
    )
  }
  return available
}

/**
 * Online + force heal. If `satoshis` provided, ensure funds still cover it.
 */
export async function prepareSpendHeal(satoshis?: number): Promise<number> {
  if (typeof satoshis === 'number' && satoshis > 0) {
    return assertSendableBalance(satoshis)
  }
  return refreshSpendableBalance()
}

/** Heal (+ optional amount check) for BRC-100 createAction / signAction. */
export async function prepareBrcActionSpend(
  method: string,
  args: unknown,
): Promise<number> {
  const sats = method === 'createAction' ? extractSatsFromArgs(method, args) : 0
  if (sats > 0) return prepareSpendHeal(sats)
  return prepareSpendHeal()
}
