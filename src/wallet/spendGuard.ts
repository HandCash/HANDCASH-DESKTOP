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
export function runExclusiveSpend<T>(fn: () => Promise<T>): Promise<T> {
  return runExclusiveSpendCoordinated(fn, acquireSpendLease)
}

/**
 * Force chain refresh; return spendable sats.
 *
 * Pre-prompt heals (BRC-100 createAction before the permission sheet) run
 * *outside* a spend session, so they must use the top-level chain ingest path.
 * Heals under `runExclusiveSpend` nest via `refreshFromChainDuringSpend`.
 */
export async function refreshSpendableBalance(): Promise<number> {
  assertOnlineForPayment()
  const active = getActiveWallet()
  if (!active) throw new Error('Wallet locked')

  const opts = { announceReceive: false, forceReview: true } as const
  const synced =
    getWalletCoordinatorSnapshot().spend === 'active'
      ? await refreshFromChainDuringSpend(opts)
      : await refreshFromChain(opts)
  if (synced != null) return synced
  return fetchBalanceSats(active.wallet)
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
