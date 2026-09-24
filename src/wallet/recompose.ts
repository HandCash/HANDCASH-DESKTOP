import { getActiveWallet } from './session'

/**
 * Device recompose tool — **isolated** from Dashboard Refresh / spend paths.
 *
 * Only call from unlock/create, History restore/import, and Pair Sync.
 * Never import this from `chainIngest` / spend paths.
 *
 * Empty-local × remote-BRC-39 clobber edge case is delegated to
 * `historyEmptyGuard.ts` via `autoPushHistoryBackupIfConfigured` — this module
 * does not invent its own overwrite rules.
 *
 * Order:
 * 1. historyReplica (optional)
 * 2. chainIngest (default)
 *
 * History failure does not skip chain; chain failure does not roll back history.
 */
import { relistCollectablesAfterLocalStateReplace } from './collectables'
import { refreshFromChainExclusive } from './chainIngest'
import {
  isRecomposeCoordinatorActive,
  runRecompose,
  shouldYieldChainIngestToSpend,
} from './walletCoordinator'
import {
  autoPushHistoryBackupIfConfigured,
  hasDeviceLinkBackupUrl,
} from './deviceSync'
import { getSessionBackupPassword, setSessionBackupPassword } from './sessionBackupAuth'
import { fetchBalanceSats} from './session'
import {
  assertRuntimeCurrent,
  getWalletRuntime,
  type WalletRuntime,
  type WalletRuntimeId,
} from './walletRuntime'
import { yieldToUi } from './yieldToUi'

export type RecomposeHistoryMode = 'auto' | 'skip' | 'forceCloud'

export type RecomposeOpts = {
  /** Unlock password; falls back to session cache. */
  password?: string | null
  reason?: string
  /**
   * auto — empty-local pull + guarded push (historyEmptyGuard)
   * skip — history already applied this turn (file/URL restore, pair sync)
   * forceCloud — same as auto (Settings recompose); still refuses empty overwrite
   */
  history?: RecomposeHistoryMode
  /** Default true — always reconcile against the chain after history. */
  chain?: boolean
}

export type RecomposeResult = {
  history: 'synced' | 'skipped' | 'none' | 'failed'
  historyError: string | null
  spendableSats: number | null
  chainError: string | null
}

let inFlight: {
  runtimeId: WalletRuntimeId | 'test'
  promise: Promise<RecomposeResult>
} | null = null

export function isRecomposeInFlight(): boolean {
  return inFlight != null || isRecomposeCoordinatorActive()
}

/** Join the current unlock/restore heal without starting another pass. */
export async function whenRecomposeIdle(): Promise<void> {
  const current = inFlight?.promise
  if (!current) return
  await current.then(
    () => undefined,
    () => undefined,
  )
}

/**
 * Rebuild localState from BRC-39 (when configured) then Refresh from chain.
 * Serialized — concurrent unlock/restore calls share one flight.
 */
export async function recomposeWallet(opts: RecomposeOpts = {}): Promise<RecomposeResult> {
  const runtime = getWalletRuntime()
  if (!runtime && import.meta.env?.MODE !== 'test') throw new Error('WALLET_LOCKED')
  const runtimeId = runtime?.runtimeId ?? 'test'
  if (inFlight?.runtimeId === runtimeId) {
    try {
      const { appendAppLog } = await import('./appLog')
      appendAppLog('info', `[recompose] join in-flight (${opts.reason ?? 'recompose'})`)
    } catch {
      /* ignore */
    }
    return inFlight.promise
  }

  const promise = runRecompose(() => runRecomposeBody(opts, runtime)).finally(() => {
    if (inFlight?.promise === promise) inFlight = null
  })
  inFlight = { runtimeId, promise }
  return promise
}

async function runRecomposeBody(
  opts: RecomposeOpts,
  runtime: WalletRuntime | null,
): Promise<RecomposeResult> {
  if (runtime) assertRuntimeCurrent(runtime)
  const reason = opts.reason ?? 'recompose'
  const historyMode = opts.history ?? 'auto'
  const runChain = opts.chain !== false
  const password = opts.password ?? getSessionBackupPassword()
  if (password) setSessionBackupPassword(password)

  let history: RecomposeResult['history'] = 'none'
  let historyError: string | null = null
  // `skip` means the caller already replaced localState (file/URL restore or
  // pair sync). An ordinary unlock/push does not invalidate the basket view.
  let localStateWasReplaced = historyMode === 'skip'

  // Bridge apps often fire BRC-100 requests the moment unlock finishes painting.
  // Yield once so a queued permission prompt can render before Argon2 / IDB work.
  await yieldToUi()

  if (historyMode !== 'skip' && password && hasDeviceLinkBackupUrl()) {
    if (shouldYieldChainIngestToSpend()) {
      history = 'skipped'
      historyError = 'deferred-for-spend'
      try {
        const { appendAppLog } = await import('./appLog')
        appendAppLog(
          'info',
          `[recompose] defer history (${reason}) — spend/permission waiting`,
        )
      } catch {
        /* ignore */
      }
    } else {
      try {
        // allowEmptyPull derived inside autoPush from reason via historyEmptyGuard.
        const sync = await autoPushHistoryBackupIfConfigured(password, {
          reason: historyMode === 'forceCloud' ? 'recompose' : reason,
        })
        if (runtime) assertRuntimeCurrent(runtime)
        localStateWasReplaced = sync.pulled
        if (sync.pulled || !sync.skipReason) {
          history = 'synced'
        } else if (sync.pullError) {
          history = 'failed'
          historyError = sync.pullError
        } else {
          history = 'skipped'
          historyError = sync.skipReason
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (
          err instanceof Error &&
          err.name === 'HistoryDeferredForSpendError'
        ) {
          history = 'skipped'
          historyError = 'deferred-for-spend'
          try {
            const { appendAppLog } = await import('./appLog')
            appendAppLog(
              'info',
              `[recompose] history yielded to spend/permission (${reason})`,
            )
          } catch {
            /* ignore */
          }
        } else {
          history = 'failed'
          historyError = msg
          try {
            const { appendAppLog } = await import('./appLog')
            appendAppLog('warn', `[recompose] history failed (${reason}): ${historyError}`)
          } catch {
            /* ignore */
          }
        }
      }
    }
  } else if (historyMode === 'skip') {
    history = 'skipped'
  }

  await yieldToUi()

  let spendableSats: number | null = null
  let chainError: string | null = null
  if (runChain) {
    try {
      // Recompose is the unlock / restore critical path. Recover spendable
      // legacy funding here, but leave ordinal discovery and AtomicBEEF
      // internalization to the first background chain pass (or Refresh).
      // Large item wallets otherwise hold the coordinator while several fat
      // BEEFs synchronously parse on the renderer thread.
      // When a permission prompt is already waiting, funding-only still runs
      // so Pay has coins, but ingest aborts early via shouldYield checks.
      spendableSats = (await refreshFromChainExclusive({
        forceReview: false,
        announceReceive: false,
        audit: false,
        fundingOnly: true,
      })).balanceSats
      if (runtime) assertRuntimeCurrent(runtime)
      if (spendableSats == null) {
        const active = getActiveWallet()
        spendableSats = active ? await fetchBalanceSats(active.wallet) : 0
      }
    } catch (err) {
      chainError = err instanceof Error ? err.message : String(err)
      try {
        const { appendAppLog } = await import('./appLog')
        appendAppLog('warn', `[recompose] chain failed (${reason}): ${chainError}`)
      } catch {
        /* ignore */
      }
    }
  }

  await yieldToUi()

  if (localStateWasReplaced) {
    if (runtime) assertRuntimeCurrent(runtime)
    await relistCollectablesAfterLocalStateReplace()
  }

  try {
    const { appendAppLog } = await import('./appLog')
    appendAppLog(
      'info',
      `[recompose] ${reason}: history=${history} sats=${spendableSats ?? 'n/a'}`,
    )
  } catch {
    /* ignore */
  }

  if (spendableSats != null && spendableSats > 0) {
    try {
      // Do not inspect all Toolbox baskets/actions again while recompose still
      // owns the coordinator. The balance is already known, and backup
      // push/restore refreshes the exact action count. Retaining the persisted
      // action baseline keeps the thin-history guard fail-closed without five
      // redundant IndexedDB reads on every unlock.
      const {
        getHistoryBackupPrefs,
        noteSpendableHighWater,
      } = await import('./historyBackupPrefs')
      const priorActions = getHistoryBackupPrefs().highWaterActionCount ?? 0
      noteSpendableHighWater(spendableSats, priorActions)
    } catch {
      /* high-water best-effort */
    }
  }

  return { history, historyError, spendableSats, chainError }
}
