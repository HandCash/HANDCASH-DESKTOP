/**
 * Parity-oriented spend guard (cloud-inspired, local):
 * - serialize spends on this device
 * - advisory lease on shared backup URL across devices
 * - force chain heal before pay
 */
import { extractSatsFromArgs } from './appActivity'
import { assertOnlineForPayment } from './paymentPolicy'
import { fetchBalanceSats, getActiveWallet } from './session'
import { syncLegacyFunds } from './syncFunds'
import { acquireSpendLease } from './spendLease'

let spendTail: Promise<unknown> = Promise.resolve()

/** Run spend-related work one-at-a-time (selection + broadcast + cross-device lease). */
export function runExclusiveSpend<T>(fn: () => Promise<T>): Promise<T> {
  const run = spendTail.then(async () => {
    const release = await acquireSpendLease()
    try {
      return await fn()
    } finally {
      await release()
    }
  }, async () => {
    const release = await acquireSpendLease()
    try {
      return await fn()
    } finally {
      await release()
    }
  })
  spendTail = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** Force chain refresh; return spendable sats. */
export async function refreshSpendableBalance(): Promise<number> {
  assertOnlineForPayment()
  const active = getActiveWallet()
  if (!active) throw new Error('Wallet locked')

  const synced = await syncLegacyFunds({
    announceReceive: false,
    forceReview: true,
  })
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
