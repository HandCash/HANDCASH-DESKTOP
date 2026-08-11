/**
 * Spend guard:
 * - serialize spends on this device (wallet coordinator spend region)
 * - advisory lease on shared backup URL across devices
 * - assert against **local** spendable balance (toolbox / history backup)
 *
 * Local wallet state is the authority for pays. Do not force chainIngest /
 * legacy address scans before send — Refresh remains a Dashboard / background
 * concern. A stale local tip fails at broadcast and is released then.
 */
import { extractSatsFromArgs } from './appActivity'
import { assertOnlineForPayment } from './paymentPolicy'
import { fetchBalanceSats, getActiveWallet } from './session'
import { acquireSpendLease } from './spendLease'
import { runExclusiveSpend as runExclusiveSpendCoordinated } from './walletCoordinator'

/** Run spend-related work one-at-a-time (selection + broadcast + cross-device lease). */
export function runExclusiveSpend<T>(
  fn: () => Promise<T>,
  onSpendRegion?: () => void,
): Promise<T> {
  return runExclusiveSpendCoordinated(fn, acquireSpendLease, onSpendRegion)
}

/**
 * @deprecated No-op. Spends no longer cache a pre-pay chain heal.
 * Kept so older call sites compile until cleaned up.
 */
export function invalidateFundingHealCache(): void {}

/** Local toolbox spendable sats — no network refresh. */
export async function refreshSpendableBalance(): Promise<number> {
  assertOnlineForPayment()
  const active = getActiveWallet()
  if (!active) throw new Error('Wallet locked')
  return fetchBalanceSats(active.wallet)
}

/** Ensure local spendable covers `satoshis`. */
export async function assertSendableBalance(satoshis: number): Promise<number> {
  if (!Number.isFinite(satoshis) || satoshis <= 0) throw new Error('Invalid amount')
  const available = await refreshSpendableBalance()
  if (satoshis > available) {
    throw new Error(
      `Insufficient balance (${available} sats available, need ${satoshis}).`,
    )
  }
  return available
}

/**
 * Pre-spend gate: online + local balance (optional amount check).
 * Name kept for call-site stability; does not heal from chain.
 */
export async function prepareSpendHeal(satoshis?: number): Promise<number> {
  if (typeof satoshis === 'number' && satoshis > 0) {
    return assertSendableBalance(satoshis)
  }
  return refreshSpendableBalance()
}

/** Local balance (+ optional amount check) for BRC-100 createAction / signAction. */
export async function prepareBrcActionSpend(
  method: string,
  args: unknown,
): Promise<number> {
  const sats = method === 'createAction' ? extractSatsFromArgs(method, args) : 0
  if (sats > 0) return prepareSpendHeal(sats)
  return prepareSpendHeal()
}
