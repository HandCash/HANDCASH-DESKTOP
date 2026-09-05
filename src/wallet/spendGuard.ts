/**
 * Spend guard:
 * - serialize spends on this device (wallet coordinator spend region)
 * - advisory lease on shared backup URL across devices
 * - assert against **local** spendable balance (toolbox / history backup)
 *
 * Local wallet state is the authority for what we own and what we can sign.
 * Validity is established at sign time; miner/indexer response is delivery only.
 * Refresh remains a Dashboard concern for reconciling with chain truth.
 */
import { extractSatsFromArgs } from './appActivity'
import { logDiag, logSpendFailure } from './diagnosticLog'
import { assertOnlineForPayment } from './paymentPolicy'
import { fetchBalanceRead, getActiveWallet } from './session'
import { acquireSpendLease } from './spendLease'
import { restoreLiveSpendableOutputs } from './staleOutputRelease'
import { runExclusiveSpend as runExclusiveSpendCoordinated } from './walletCoordinator'

/** True while {@link runExclusiveSpend} already promoted chained change. */
let spendChainPromoted = false

export type SpendPromoteMode = 'full' | 'light'

/**
 * Fee headroom for BRC-100 createAction / signAction gates.
 * Apps often pass only payment outputs; toolbox still needs fee UTXOs.
 */
export const BRC_ACTION_FEE_BUFFER_SATS = 1000

/** Distinguishes "wait / retry — change is chaining" from hard insufficient. */
export class ChangeChainingRequiredError extends Error {
  readonly code = 'CHANGE_CHAINING_REQUIRED' as const
  readonly confirmedSats: number
  readonly confirmingSats: number
  readonly neededSats: number

  constructor(opts: {
    message: string
    confirmedSats: number
    confirmingSats: number
    neededSats: number
  }) {
    super(opts.message)
    this.name = 'ChangeChainingRequiredError'
    this.confirmedSats = opts.confirmedSats
    this.confirmingSats = opts.confirmingSats
    this.neededSats = opts.neededSats
  }
}

export function isChangeChainingRequiredError(
  err: unknown,
): err is ChangeChainingRequiredError {
  return (
    err instanceof ChangeChainingRequiredError ||
    (err instanceof Error &&
      (err as { code?: string }).code === 'CHANGE_CHAINING_REQUIRED')
  )
}

/**
 * Rebuild script-less change rows and mark live pending change spendable for chaining.
 * Local toolbox only — no chain raw-tx sweep (that belongs on Dashboard Refresh).
 *
 * `light` skips the unscripted-output script sweep (thousands of rows on large
 * wallets). Ordinal sends only need a fee UTXO — running the full sweep first
 * blocked "Preparing payment" for minutes while change-script heal scanned ~2k
 * outputs (see lab logs hc-ad7afbfaae0d01fffcb3).
 */
async function promoteSpendableChange(
  mode: SpendPromoteMode = 'full',
): Promise<number> {
  let restored = 0
  let localHealed = 0
  try {
    const { sweepChangeScripts } = await import('./changeScriptFate')
    const {
      reclaimSealedInputsNeverSpent,
      promotePendingLocalChangeOutputs,
    } = await import('./staleOutputRelease')
    await reclaimSealedInputsNeverSpent({ forSpendChain: true })
    await promotePendingLocalChangeOutputs({ forSpendChain: true })
    if (mode === 'full') {
      const localSweep = await sweepChangeScripts({ fromChain: false })
      localHealed = localSweep.healed
    }
    const restorePasses = mode === 'full' ? 5 : 1
    for (let pass = 0; pass < restorePasses && restored === 0; pass += 1) {
      restored += (
        await restoreLiveSpendableOutputs({ forSpendChain: true })
      ).restored
    }
    if (mode === 'full' && restored === 0 && localHealed > 0) {
      restored += (
        await restoreLiveSpendableOutputs({ forSpendChain: true })
      ).restored
    }
  } catch (err) {
    logDiag('spend-guard', 'warn', 'promote-skipped', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
  if (restored > 0 || localHealed > 0) {
    logDiag('spend-guard', 'info', 'promoted', {
      restored,
      scriptsLocal: localHealed,
      mode,
    })
  }
  return restored
}

/** Run spend-related work one-at-a-time (selection + broadcast + cross-device lease). */
export function runExclusiveSpend<T>(
  fn: () => Promise<T>,
  onSpendRegion?: () => void,
  opts?: { promote?: SpendPromoteMode },
): Promise<T> {
  const promote = opts?.promote ?? 'full'
  return runExclusiveSpendCoordinated(async () => {
    await promoteSpendableChange(promote)
    spendChainPromoted = true
    try {
      return await fn()
    } finally {
      spendChainPromoted = false
    }
  }, acquireSpendLease, onSpendRegion)
}

/**
 * Burn / destroy paths call this so `requestSpendPriority` is held **before**
 * FIFO acquire — collectables `listOutputs` then yields while burn waits.
 */
export async function runExclusiveBurn<T>(
  reason: string,
  fn: () => Promise<T>,
): Promise<T> {
  const { leaseSpendPriority } = await import('./walletCoordinator')
  const priority = leaseSpendPriority(reason)
  const heartbeat = setInterval(() => priority.touch(), 30_000)
  try {
    return await runExclusiveSpend(fn)
  } finally {
    clearInterval(heartbeat)
    priority.release()
  }
}

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
 * Fast pre-review gate — read local confirmed balance only.
 * Does not promote change or sweep scripts (Review must stay snappy).
 */
export async function assertSendableBalanceForReview(satoshis: number): Promise<number> {
  if (!Number.isFinite(satoshis) || satoshis <= 0) throw new Error('Invalid amount')
  assertOnlineForPayment()
  const active = getActiveWallet()
  if (!active) throw new Error('Wallet locked')

  const confirmed = await readConfirmedSpendable(active)
  if (satoshis <= confirmed) return confirmed

  let confirming = 0
  try {
    const { unconfirmedChangeSats } = await import('./balanceView')
    confirming = await unconfirmedChangeSats()
  } catch (err) {
    logDiag('spend-guard', 'warn', 'unconfirmed-credit-skipped', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  if (confirming > 0 && confirmed + confirming >= satoshis) {
    const { insufficientFundsMessage } = await import('./insufficientFunds')
    throw new ChangeChainingRequiredError({
      message: insufficientFundsMessage({
        confirmedSats: confirmed,
        confirmingSats: confirming,
        neededSats: satoshis,
      }),
      confirmedSats: confirmed,
      confirmingSats: confirming,
      neededSats: satoshis,
    })
  }

  throw new Error(
    `Insufficient balance (${confirmed} sats available, need ${satoshis}).`,
  )
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

  // Display balance credits pending change; createAction only selects spendable
  // toolbox rows. Promote live change — never pass the gate on credit alone.
  if (!spendChainPromoted) await promoteSpendableChange()
  confirmed = await readConfirmedSpendable(active)
  if (satoshis <= confirmed) return confirmed

  let confirming = 0
  try {
    const { unconfirmedChangeSats } = await import('./balanceView')
    confirming = await unconfirmedChangeSats()
  } catch (err) {
    logDiag('spend-guard', 'warn', 'unconfirmed-credit-skipped', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  if (confirming > 0 && confirmed + confirming >= satoshis) {
    // One more light promote even inside an exclusive spend — prior createAction
    // / internalize may have written outs after the region-entry promote ran.
    await promoteSpendableChange('light')
    confirmed = await readConfirmedSpendable(active)
    if (satoshis <= confirmed) return confirmed

    const { insufficientFundsMessage } = await import('./insufficientFunds')
    await logSpendFailure('chaining-required', {
      needed: satoshis,
      confirmed,
      confirming,
    })
    throw new ChangeChainingRequiredError({
      message: insufficientFundsMessage({
        confirmedSats: confirmed,
        confirmingSats: confirming,
        neededSats: satoshis,
      }),
      confirmedSats: confirmed,
      confirmingSats: confirming,
      neededSats: satoshis,
    })
  }

  await logSpendFailure('insufficient', { needed: satoshis, confirmed, confirming })
  throw new Error(
    `Insufficient balance (${confirmed} sats available, need ${satoshis}).`,
  )
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
  if (sats > 0) return prepareSpendHeal(sats + BRC_ACTION_FEE_BUFFER_SATS)
  return prepareSpendHeal()
}
