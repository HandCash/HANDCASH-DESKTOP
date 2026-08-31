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
import { fetchBalanceRead, getActiveWallet } from './session'
import { acquireSpendLease } from './spendLease'
import { restoreLiveSpendableOutputs } from './staleOutputRelease'
import { runExclusiveSpend as runExclusiveSpendCoordinated } from './walletCoordinator'

/** Run spend-related work one-at-a-time (selection + broadcast + cross-device lease). */
export function runExclusiveSpend<T>(
  fn: () => Promise<T>,
  onSpendRegion?: () => void,
): Promise<T> {
  return runExclusiveSpendCoordinated(async () => {
    try {
      await restoreLiveSpendableOutputs({ forSpendChain: true })
    } catch (err) {
      console.warn('[spend-guard] chain restore skipped', err)
    }
    return fn()
  }, acquireSpendLease, onSpendRegion)
}

/**
 * @deprecated No-op. Spends no longer cache a pre-pay chain heal.
 * Kept so older call sites compile until cleaned up.
 */
export function invalidateFundingHealCache(): void {}

const BALANCE_UNREADABLE =
  'Wallet storage is busy, so your spendable balance could not be read. Nothing was sent — try again in a moment.'

/**
 * Confirmed spendable sats, or a refusal.
 *
 * An unreadable balance must never be spent against as 0: that reports a funded
 * wallet as broke and hides a storage problem behind a wrong number.
 */
async function readConfirmedSpendable(active: {
  wallet: Parameters<typeof fetchBalanceRead>[0]
}): Promise<number> {
  const read = await fetchBalanceRead(active.wallet, { creditUnconfirmed: false })
  if (read.kind === 'unavailable') throw new Error(BALANCE_UNREADABLE)
  return read.sats
}

/** Local toolbox spendable sats — no network refresh, no unconfirmed credit. */
export async function refreshSpendableBalance(): Promise<number> {
  assertOnlineForPayment()
  const active = getActiveWallet()
  if (!active) throw new Error('Wallet locked')
  return readConfirmedSpendable(active)
}

/**
 * Ensure local spendable covers `satoshis`.
 *
 * Confirmed toolbox balance is checked first. The unconfirmed-change scan only
 * runs when that is short — a phone with hundreds of unspendable rows was
 * paying that cost on every Send even when confirmed coins already covered the
 * payment.
 */
export async function assertSendableBalance(satoshis: number): Promise<number> {
  if (!Number.isFinite(satoshis) || satoshis <= 0) throw new Error('Invalid amount')
  assertOnlineForPayment()
  const active = getActiveWallet()
  if (!active) throw new Error('Wallet locked')

  let confirmed = await readConfirmedSpendable(active)
  if (satoshis <= confirmed) return confirmed

  // Display balance already credits pending change; createAction only selects
  // `spendable: true` rows. Promote live change inside the spend region so
  // back-to-back sends/burns chain on unconfirmed fee change without polling.
  try {
    await restoreLiveSpendableOutputs({ forSpendChain: true })
    confirmed = await readConfirmedSpendable(active)
    if (satoshis <= confirmed) return confirmed
  } catch (err) {
    console.warn('[spend-guard] live change restore skipped', err)
  }

  let credit = 0
  try {
    const { unconfirmedChangeSats } = await import('./balanceView')
    credit = await unconfirmedChangeSats({ needAtLeast: satoshis - confirmed })
  } catch (err) {
    console.warn('[spend-guard] unconfirmed change credit skipped', err)
  }
  const available = confirmed + credit
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
  const sats =
    method === 'createAction' || method === 'signAction'
      ? extractSatsFromArgs(method, args)
      : 0
  if (sats > 0) return prepareSpendHeal(sats)
  return prepareSpendHeal()
}
