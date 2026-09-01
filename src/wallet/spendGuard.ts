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
import { logDiag, logSpendFailure } from './diagnosticLog'
import { assertOnlineForPayment } from './paymentPolicy'
import { fetchBalanceRead, getActiveWallet } from './session'
import { acquireSpendLease } from './spendLease'
import {
  promotePendingLocalChangeOutputs,
  reclaimSealedInputsNeverSpent,
  restoreLiveSpendableOutputs,
} from './staleOutputRelease'
import { sweepChangeScripts } from './changeScriptFate'
import { runExclusiveSpend as runExclusiveSpendCoordinated } from './walletCoordinator'

/** True while {@link runExclusiveSpend} already promoted chained change. */
let spendChainPromoted = false

/** Rebuild script-less change rows and mark live pending change spendable for chaining. */
async function promoteSpendableChange(): Promise<number> {
  let restored = 0
  let localHealed = 0
  let chainHealed = 0
  try {
    // Coins sealed for a broadcast that never landed — reclaim before selection.
    await reclaimSealedInputsNeverSpent({ forSpendChain: true })
    // Pending change from live sends — O(live txs), not O(unspendable rows).
    await promotePendingLocalChangeOutputs({ forSpendChain: true })
    const localSweep = await sweepChangeScripts({ fromChain: false })
    localHealed = localSweep.healed
    for (let pass = 0; pass < 5 && restored === 0; pass += 1) {
      restored += await restoreLiveSpendableOutputs({ forSpendChain: true })
    }
    if (restored === 0 && localHealed > 0) {
      restored += await restoreLiveSpendableOutputs({ forSpendChain: true })
    }
    // Script-less change credited in the hero balance but skipped by restore —
    // one bounded chain pass heals rows local raw tx could not rebuild.
    if (restored === 0 && localHealed === 0) {
      const chainSweep = await sweepChangeScripts({ fromChain: true })
      chainHealed = chainSweep.healed
      if (chainHealed > 0) {
        restored += await restoreLiveSpendableOutputs({ forSpendChain: true })
      }
    }
  } catch (err) {
    logDiag('spend-guard', 'warn', 'promote-skipped', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
  if (restored > 0 || localHealed > 0 || chainHealed > 0) {
    logDiag('spend-guard', 'info', 'promoted', {
      restored,
      scriptsLocal: localHealed,
      scriptsChain: chainHealed,
    })
  }
  return restored
}

/** Run spend-related work one-at-a-time (selection + broadcast + cross-device lease). */
export function runExclusiveSpend<T>(
  fn: () => Promise<T>,
  onSpendRegion?: () => void,
): Promise<T> {
  return runExclusiveSpendCoordinated(async () => {
    await promoteSpendableChange()
    spendChainPromoted = true
    try {
      return await fn()
    } finally {
      spendChainPromoted = false
    }
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

  // Display balance credits pending change; createAction only selects spendable
  // toolbox rows. Promote live change — never pass the gate on credit alone.
  if (!spendChainPromoted) {
    await promoteSpendableChange()
  } else {
    // runExclusiveSpend already ran promoteSpendableChange at queue entry. When
    // bulk restore could not reach this wallet's pending credit (small UTXO
    // count on mobile, huge dead row count on desktop), retry the O(live-txs)
    // path here instead of throwing "chain unconfirmed change" while funds exist.
    await promotePendingLocalChangeOutputs({ forSpendChain: true })
    await restoreLiveSpendableOutputs({ forSpendChain: true })
  }
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
    // Last pass: chain script heal for script-less pending change, then re-read.
    const chainSweep = await sweepChangeScripts({ fromChain: true })
    if (chainSweep.healed > 0) {
      await promotePendingLocalChangeOutputs({ forSpendChain: true })
      await restoreLiveSpendableOutputs({ forSpendChain: true })
      confirmed = await readConfirmedSpendable(active)
      if (satoshis <= confirmed) return confirmed
    }
    const { insufficientFundsMessage } = await import('./insufficientFunds')
    await logSpendFailure('chaining-required', {
      needed: satoshis,
      confirmed,
      confirming,
    })
    throw new Error(
      insufficientFundsMessage({
        confirmedSats: confirmed,
        confirmingSats: confirming,
        neededSats: satoshis,
      }),
    )
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
  if (sats > 0) return prepareSpendHeal(sats)
  return prepareSpendHeal()
}
