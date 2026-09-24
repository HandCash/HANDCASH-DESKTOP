/**
 * Explicit paths for promoting chained unconfirmed change → spendable toolbox rows.
 * SSoT for heal ordering; callers pick a {@link ChangeHealPath}, not booleans.
 *
 * Spend-path heals must stay **fast** (local IDB, O(live txs)) — full script sweeps
 * and chain raw-tx lookups belong on Refresh (`chainMaintenance`) or the last-resort
 * gate (`chainingScriptHeal`), not on every `runExclusiveSpend` entry.
 */
import { sweepChangeScripts } from './changeScriptFate'
import { logDiag } from './diagnosticLog'
import { bumpBalanceAfterHeal } from './session'
import {
  getSpendPriorityDepth,
  shouldYieldChainIngestToSpend,
} from './walletCoordinator'
import {
  promotePendingLocalChangeOutputs,
  reclaimSealedInputsNeverSpent,
  rehideInputsOfLiveLocalTxs,
  restoreLiveSpendableOutputs,
  type RestoreLiveSpendableResult,
} from './staleOutputRelease'

/** Legal change-heal transitions — one path per caller context. */
export type ChangeHealPath =
  /** Fast promote before spend selection — no paged script sweep, no chain fetch. */
  | { path: 'spendGate' }
  /** Retry pending-tx promote when spendGate already ran but bulk restore missed credit. */
  | { path: 'spendGatePartialRetry' }
  /** Lightweight promote after display credits pending change — never reclaim. */
  | { path: 'displayBackground' }
  /** Refresh maintenance: script sweep → rehide → promote → restore → reclaim. */
  | { path: 'chainMaintenance'; throwIfYield?: () => void }
  /** Last resort when display credit covers payment but confirmed does not. */
  | { path: 'chainingScriptHeal' }

export type ChangeHealStats = {
  restored: number
  scriptsLocal: number
  scriptsChain: number
  pendingPromoted: number
  reclaimed: number
  /**
   * Rows the last restore refused for want of a locking script. A script-less
   * change row counts in neither balance bucket, so this is the only signal
   * that a chain script sweep is still owed.
   */
  unscripted: number
}

function emptyStats(): ChangeHealStats {
  return {
    restored: 0,
    scriptsLocal: 0,
    scriptsChain: 0,
    pendingPromoted: 0,
    reclaimed: 0,
    unscripted: 0,
  }
}

function restoreStillStuck(result: RestoreLiveSpendableResult): boolean {
  return result.restored === 0 || result.unscripted > 0
}

async function retryRestoreAfterScriptHeal(
  stats: ChangeHealStats,
): Promise<RestoreLiveSpendableResult> {
  stats.pendingPromoted += await promotePendingLocalChangeOutputs()
  const next = await restoreLiveSpendableOutputs()
  stats.restored += next.restored
  stats.unscripted = next.unscripted
  return next
}

function noteHeal(stats: ChangeHealStats): void {
  if (
    stats.restored > 0 ||
    stats.scriptsLocal > 0 ||
    stats.scriptsChain > 0 ||
    stats.pendingPromoted > 0 ||
    stats.reclaimed > 0
  ) {
    bumpBalanceAfterHeal()
  }
}

/**
 * Run one chained-change heal path. Returns counts for logging; never throws —
 * callers fail closed on spend gates separately.
 */
export async function runChangeHeal(path: ChangeHealPath): Promise<ChangeHealStats> {
  const stats = emptyStats()

  switch (path.path) {
    case 'displayBackground': {
      // Promote only. Reclaim on a display tick revived sealed app-spend
      // inputs (missing local tx row) and bounced the hero with no Activity.
      stats.pendingPromoted = await promotePendingLocalChangeOutputs()
      noteHeal(stats)
      return stats
    }

    case 'spendGatePartialRetry': {
      stats.pendingPromoted = await promotePendingLocalChangeOutputs()
      const retry = await restoreLiveSpendableOutputs()
      stats.restored = retry.restored
      stats.unscripted = retry.unscripted
      noteHeal(stats)
      return stats
    }

    case 'chainingScriptHeal': {
      const localSweep = await sweepChangeScripts({ fromChain: false })
      stats.scriptsLocal = localSweep.healed
      let restoreResult: RestoreLiveSpendableResult = { restored: 0, unscripted: 0 }
      if (localSweep.healed > 0) {
        stats.pendingPromoted = await promotePendingLocalChangeOutputs()
        restoreResult = await restoreLiveSpendableOutputs()
        stats.restored = restoreResult.restored
        stats.unscripted = restoreResult.unscripted
      }
      // The chain sweep is budgeted (CHAIN_FETCH_MAX raw-tx fetches per call),
      // so a wallet whose whole balance lost its scripts needs more than one
      // pass. Keep going only while a pass still heals something.
      for (let pass = 0; pass < 4 && restoreStillStuck(restoreResult); pass += 1) {
        const chainSweep = await sweepChangeScripts({ fromChain: true })
        stats.scriptsChain += chainSweep.healed
        if (chainSweep.healed > 0) {
          restoreResult = await retryRestoreAfterScriptHeal(stats)
        }
        // A send cut the pass short. Re-scanning every output to squeeze in one
        // more short batch would just tax the spend; the post-send cleanup heal
        // picks the sweep up where this left it.
        if (chainSweep.deferred) break
        // A pass that healed nothing is not proof the sweep is finished: it
        // may have spent its whole batch on rows it had to refuse. Stop only
        // when no script-less row is left unattempted.
        if (chainSweep.healed === 0 && chainSweep.remaining === 0) break
      }
      noteHeal(stats)
      return stats
    }

    case 'spendGate': {
      try {
        // Auto heal + post-cleanup hold chainIngest; must yield so burns can acquire.
        // Spend-path promote uses spendGuard.promoteSpendableChange (forSpendChain).
        // Rehide FIRST — vault sibling abortReserved (v1.3.146) left spent inputs
        // spendable; reclaim/promote without rehide doubles the hero.
        await rehideInputsOfLiveLocalTxs()
        stats.reclaimed = await reclaimSealedInputsNeverSpent()
        stats.pendingPromoted = await promotePendingLocalChangeOutputs()
        const gateRestore = await restoreLiveSpendableOutputs()
        stats.restored = gateRestore.restored
        stats.unscripted = gateRestore.unscripted
      } catch (err) {
        logDiag('change-heal', 'warn', 'spend-gate-skipped', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
      if (
        stats.restored > 0 ||
        stats.pendingPromoted > 0 ||
        stats.reclaimed > 0
      ) {
        logDiag('change-heal', 'info', 'spend-gate', stats)
      }
      noteHeal(stats)
      return stats
    }

    case 'chainMaintenance': {
      const throwIfYield = path.throwIfYield ?? (() => {})
      for (let pass = 0; pass < 4; pass += 1) {
        throwIfYield()
        const sweep = await sweepChangeScripts({ fromChain: true })
        stats.scriptsChain += sweep.healed
        if (sweep.deferred) break
        if (sweep.healed === 0 && sweep.remaining === 0) break
      }
      throwIfYield()
      await rehideInputsOfLiveLocalTxs()
      throwIfYield()
      stats.pendingPromoted = await promotePendingLocalChangeOutputs()
      for (let pass = 0; pass < 5; pass += 1) {
        throwIfYield()
        const batch = await restoreLiveSpendableOutputs()
        stats.unscripted = batch.unscripted
        if (batch.restored === 0) break
        stats.restored += batch.restored
      }
      for (let pass = 0; pass < 3; pass += 1) {
        throwIfYield()
        const reclaimed = await reclaimSealedInputsNeverSpent()
        if (reclaimed === 0) break
        stats.reclaimed += reclaimed
      }
      noteHeal(stats)
      return stats
    }
  }
}

/** Release stuck send reservations and promote orphaned change after Activity cleanup. */
export function scheduleHealAfterSendCleanup(): void {
  void (async () => {
    try {
      if (getSpendPriorityDepth() > 0 || shouldYieldChainIngestToSpend()) {
        console.info('[change-heal] post-cleanup heal deferred — spend active')
        return
      }
      const { releaseSpendAttemptFunds } = await import('./spendAttempt')
      await releaseSpendAttemptFunds()
      const gate = await runChangeHeal({ path: 'spendGate' })
      if (gate.pendingPromoted === 0 && gate.restored === 0 && gate.reclaimed === 0) {
        await runChangeHeal({ path: 'chainingScriptHeal' })
      }
    } catch (err) {
      console.warn(
        '[change-heal] post-cleanup heal skipped',
        err instanceof Error ? err.message : String(err),
      )
    }
  })()
}
