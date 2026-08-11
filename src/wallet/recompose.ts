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
import { clearCollectablesCache } from './collectables'
import { refreshFromChainExclusive } from './chainIngest'
import {
  isRecomposeCoordinatorActive,
  runRecompose,
} from './walletCoordinator'
import {
  autoPushHistoryBackupIfConfigured,
  hasDeviceLinkBackupUrl,
} from './deviceSync'
import { getSessionBackupPassword, setSessionBackupPassword } from './sessionBackupAuth'
import { fetchBalanceSats, getActiveWallet } from './session'

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

let inFlight: Promise<RecomposeResult> | null = null

export function isRecomposeInFlight(): boolean {
  return inFlight != null || isRecomposeCoordinatorActive()
}

/**
 * Rebuild localState from BRC-39 (when configured) then Refresh from chain.
 * Serialized — concurrent unlock/restore calls share one flight.
 */
export async function recomposeWallet(opts: RecomposeOpts = {}): Promise<RecomposeResult> {
  if (inFlight) {
    try {
      const { appendAppLog } = await import('./appLog')
      appendAppLog('info', `[recompose] join in-flight (${opts.reason ?? 'recompose'})`)
    } catch {
      /* ignore */
    }
    return inFlight
  }

  inFlight = runRecompose(() => runRecomposeBody(opts)).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function runRecomposeBody(opts: RecomposeOpts): Promise<RecomposeResult> {
  const reason = opts.reason ?? 'recompose'
  const historyMode = opts.history ?? 'auto'
  const runChain = opts.chain !== false
  const password = opts.password ?? getSessionBackupPassword()
  if (password) setSessionBackupPassword(password)

  let history: RecomposeResult['history'] = 'none'
  let historyError: string | null = null

  if (historyMode !== 'skip' && password && hasDeviceLinkBackupUrl()) {
    try {
      // allowEmptyPull derived inside autoPush from reason via historyEmptyGuard.
      await autoPushHistoryBackupIfConfigured(password, {
        reason: historyMode === 'forceCloud' ? 'recompose' : reason,
      })
      history = 'synced'
    } catch (err) {
      history = 'failed'
      historyError = err instanceof Error ? err.message : String(err)
      try {
        const { appendAppLog } = await import('./appLog')
        appendAppLog('warn', `[recompose] history failed (${reason}): ${historyError}`)
      } catch {
        /* ignore */
      }
    }
  } else if (historyMode === 'skip') {
    history = 'skipped'
  }

  let spendableSats: number | null = null
  let chainError: string | null = null
  if (runChain) {
    try {
      spendableSats = (await refreshFromChainExclusive({
        forceReview: true,
        announceReceive: false,
      })).balanceSats
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

  clearCollectablesCache()

  try {
    const { appendAppLog } = await import('./appLog')
    appendAppLog(
      'info',
      `[recompose] ${reason}: history=${history} sats=${spendableSats ?? 'n/a'}`,
    )
  } catch {
    /* ignore */
  }

  return { history, historyError, spendableSats, chainError }
}
