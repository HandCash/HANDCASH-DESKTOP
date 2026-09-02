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
  /** Lightweight promote after display balance credits pending change. */
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
}

function emptyStats(): ChangeHealStats {
  return {
    restored: 0,
    scriptsLocal: 0,
    scriptsChain: 0,
    pendingPromoted: 0,
    reclaimed: 0,
  }
}

function restoreStillStuck(result: RestoreLiveSpendableResult): boolean {
  return result.restored === 0 || result.unscripted > 0
}

async function retryRestoreAfterScriptHeal(
  stats: ChangeHealStats,
): Promise<RestoreLiveSpendableResult> {
  stats.pendingPromoted += await promotePendingLocalChangeOutputs({ forSpendChain: true })
  const next = await restoreLiveSpendableOutputs({ forSpendChain: true })
  stats.restored += next.restored
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
      stats.pendingPromoted = await promotePendingLocalChangeOutputs({ forSpendChain: true })
      stats.reclaimed = await reclaimSealedInputsNeverSpent({ forSpendChain: true })
      noteHeal(stats)
      return stats
    }

    case 'spendGatePartialRetry': {
      stats.pendingPromoted = await promotePendingLocalChangeOutputs({ forSpendChain: true })
      stats.restored = (
        await restoreLiveSpendableOutputs({ forSpendChain: true })
      ).restored
      noteHeal(stats)
      return stats
    }

    case 'chainingScriptHeal': {
      const localSweep = await sweepChangeScripts({ fromChain: false })
      stats.scriptsLocal = localSweep.healed
      let restoreResult: RestoreLiveSpendableResult = { restored: 0, unscripted: 0 }
      if (localSweep.healed > 0) {
        stats.pendingPromoted = await promotePendingLocalChangeOutputs({ forSpendChain: true })
        restoreResult = await restoreLiveSpendableOutputs({ forSpendChain: true })
        stats.restored = restoreResult.restored
      }
      if (restoreStillStuck(restoreResult)) {
        const chainSweep = await sweepChangeScripts({ fromChain: true })
        stats.scriptsChain = chainSweep.healed
        if (chainSweep.healed > 0) {
          restoreResult = await retryRestoreAfterScriptHeal(stats)
        }
      }
      noteHeal(stats)
      return stats
    }

    case 'spendGate': {
      try {
        stats.reclaimed = await reclaimSealedInputsNeverSpent({ forSpendChain: true })
        stats.pendingPromoted = await promotePendingLocalChangeOutputs({ forSpendChain: true })
        stats.restored = (
          await restoreLiveSpendableOutputs({ forSpendChain: true })
        ).restored
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
        if (sweep.healed === 0) break
      }
      throwIfYield()
      await rehideInputsOfLiveLocalTxs()
      throwIfYield()
      stats.pendingPromoted = await promotePendingLocalChangeOutputs()
      for (let pass = 0; pass < 5; pass += 1) {
        throwIfYield()
        const batch = await restoreLiveSpendableOutputs()
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
