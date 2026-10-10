import { getActiveWallet } from './session'

/**
 * Device recompose tool — **isolated** from Dashboard Refresh / spend paths.
 *
 * Only call from unlock/create, History restore/import, Pair Sync, the first
 * open of an empty vault account, and an account moving onto this device
 * (`refreshAfterAccountSwitch`).
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
import { refreshFromChain, refreshFromChainExclusive } from './chainIngest'
import {
  foregroundSpendWaiting,
  isRecomposeCoordinatorActive,
  runRecompose,
  shouldYieldChainIngestToSpend,
} from './walletCoordinator'
import {
  autoPushHistoryBackupIfConfigured,
  hasDeviceLinkBackupUrl,
  mergeArrivedAccountHistory,
} from './deviceSync'
import { sessionBackupCredential, setSessionBackupPassword } from './sessionBackupAuth'
import { fetchBalanceSats} from './session'
import {
  assertRuntimeCurrent,
  getWalletRuntime,
  type WalletRuntime,
  type WalletRuntimeId,
} from './walletRuntime'
import { inUiPhase } from './uiPhase'
import { yieldToUi } from './yieldToUi'

export type RecomposeHistoryMode = 'auto' | 'skip' | 'forceCloud' | 'mergeArrived'

export type RecomposeOpts = {
  /** Unlock password; falls back to session cache. */
  password?: string | null
  reason?: string
  /**
   * auto — empty-local pull + guarded push (historyEmptyGuard)
   * skip — history already applied this turn (file/URL restore, pair sync)
   * forceCloud — same as auto (Settings recompose); still refuses empty overwrite
   * mergeArrived — the account just moved here: merge its remote BRC-39 even
   *   when local is not empty, and never defer that for a waiting spend
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

  const promise = runRecomposeBody(opts, runtime)
    .then(
      (result) =>
        disposedMidFlight(result.historyError) || disposedMidFlight(result.chainError)
          ? rerunOnReplacement(opts, runtime, result)
          : result,
      (err: unknown) =>
        disposedMidFlight(err instanceof Error ? err.message : String(err))
          ? rerunOnReplacement(opts, runtime, err)
          : Promise.reject(err),
    )
    .finally(() => {
      if (inFlight?.promise === promise) inFlight = null
    })
  inFlight = { runtimeId, promise }
  return promise
}

/**
 * After switching vault accounts. An account that just moved onto this device
 * merges the history its previous holder flushed. An account opening empty on
 * this device (a restored vault, an account found by discovery) has its
 * history only in its own backup, so it recomposes as an unlock would. Any
 * other account refreshes from the chain.
 */
export async function refreshAfterAccountSwitch(opts: { arrived?: boolean } = {}): Promise<void> {
  if (opts.arrived) {
    await recomposeWallet({ reason: 'account-arrived', history: 'mergeArrived' })
    return
  }
  const { localToolboxStateLooksEmpty } = await import('./layers')
  if (await localToolboxStateLooksEmpty()) {
    await recomposeWallet({ reason: 'account-switch' })
    return
  }
  await refreshFromChain({ announceReceive: false })
}

function disposedMidFlight(message: string | null | undefined): boolean {
  return Boolean(message?.includes('Wallet runtime disposed'))
}

/**
 * Restore and unlock hand off to the app, which boots a fresh runtime for the
 * same identity. A pass aborted by that handoff reruns on the replacement;
 * reporting it as an empty wallet strands the history it never pulled.
 */
async function rerunOnReplacement(
  opts: RecomposeOpts,
  runtime: WalletRuntime | null,
  outcome: unknown,
): Promise<RecomposeResult> {
  const next = getWalletRuntime()
  const replaced =
    runtime != null &&
    next != null &&
    next.runtimeId !== runtime.runtimeId &&
    next.instance.identityKey === runtime.instance.identityKey
  if (!replaced) {
    if (outcome instanceof Error) throw outcome
    return outcome as RecomposeResult
  }
  try {
    const { appendAppLog } = await import('./appLog')
    appendAppLog('info', `[recompose] runtime replaced mid-flight — rerun (${opts.reason ?? 'recompose'})`)
  } catch {
    /* ignore */
  }
  return recomposeWallet(opts)
}

type HistoryStep = Pick<RecomposeResult, 'history' | 'historyError'> & { localStateWasReplaced: boolean }
type ChainStep = Pick<RecomposeResult, 'spendableSats' | 'chainError'>

const NO_CHAIN: ChainStep = { spendableSats: null, chainError: null }

async function runRecomposeBody(
  opts: RecomposeOpts,
  runtime: WalletRuntime | null,
): Promise<RecomposeResult> {
  if (runtime) assertRuntimeCurrent(runtime)
  const reason = opts.reason ?? 'recompose'
  const runChain = opts.chain !== false

  // The recompose region excludes every spend. A replaced localState stays
  // fenced until chain has reconciled it and Collect has relisted it. An
  // unchanged one is fenced only for the history decision: its funding pass
  // is ordinary chain ingest, which a spend runs beside — on a large wallet
  // that pass takes minutes, and a waiting payment or import must not.
  const fenced = await runRecompose(async () => {
    const step = await recomposeHistory(opts, runtime, reason)
    if (!step.localStateWasReplaced) return { step, chain: null }
    const chain = runChain ? await recomposeChain(runtime, reason, 'fenced') : NO_CHAIN
    await yieldToUi()
    if (runtime) assertRuntimeCurrent(runtime)
    await inUiPhase('recompose-relist', () => relistCollectablesAfterLocalStateReplace())
    return { step, chain }
  })
  const { history, historyError } = fenced.step
  const { spendableSats, chainError } =
    fenced.chain ?? (runChain ? await recomposeChain(runtime, reason, 'shared') : NO_CHAIN)

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
      // Do not inspect all Toolbox baskets/actions again on unlock. The
      // balance is already known, and backup push/restore refreshes the exact
      // action count. Retaining the persisted action baseline keeps the
      // thin-history guard fail-closed without redundant IndexedDB reads.
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

  if (runtime) scheduleDerivedChangePass(runtime, fenced.step.localStateWasReplaced)
  return { history, historyError, spendableSats, chainError }
}

async function recomposeHistory(
  opts: RecomposeOpts,
  runtime: WalletRuntime | null,
  reason: string,
): Promise<HistoryStep> {
  const historyMode = opts.history ?? 'auto'
  const password = opts.password ?? sessionBackupCredential()
  if (password) setSessionBackupPassword(password)

  let history: RecomposeResult['history'] = 'none'
  let historyError: string | null = null
  // `skip` means the caller already replaced localState (file/URL restore or
  // pair sync). An ordinary unlock/push does not invalidate the basket view.
  let localStateWasReplaced = historyMode === 'skip'

  // Bridge apps often fire BRC-100 requests the moment unlock finishes painting.
  // Yield once so a queued permission prompt can render before Argon2 / IDB work.
  await yieldToUi()

  if (historyMode === 'mergeArrived') {
    // Spends wait on this one: until it lands, local coins may already be
    // spent by the device the account came from.
    const sync = await inUiPhase('recompose-history', () => mergeArrivedAccountHistory(password))
    if (runtime) assertRuntimeCurrent(runtime)
    localStateWasReplaced = sync.pulled
    if (sync.pulled) history = 'synced'
    else if (sync.pullError) {
      history = 'failed'
      historyError = sync.pullError
    } else {
      history = 'skipped'
      historyError = sync.skipReason
    }
  } else if (historyMode !== 'skip' && password != null && hasDeviceLinkBackupUrl()) {
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
        const sync = await inUiPhase('recompose-history', () =>
          autoPushHistoryBackupIfConfigured(password, {
            reason: historyMode === 'forceCloud' ? 'recompose' : reason,
          }),
        )
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
  return { history, historyError, localStateWasReplaced }
}

/**
 * Recover spendable legacy funding, leaving ordinal discovery and AtomicBEEF
 * internalization to the first background chain pass (or Refresh): large item
 * wallets would otherwise parse several fat BEEFs on the renderer here. When a
 * permission prompt is already waiting the pass still runs so Pay has coins,
 * but ingest aborts early via its shouldYield checks.
 *
 * `fenced` runs inside the recompose region; `shared` takes the chain ingest
 * region like any Refresh.
 */
async function recomposeChain(
  runtime: WalletRuntime | null,
  reason: string,
  region: 'fenced' | 'shared',
): Promise<ChainStep> {
  const pass = { forceReview: false, announceReceive: false, audit: false, fundingOnly: true }
  try {
    let spendableSats = await inUiPhase('recompose-chain', async () =>
      region === 'fenced' ? (await refreshFromChainExclusive(pass)).balanceSats : refreshFromChain(pass),
    )
    if (runtime) assertRuntimeCurrent(runtime)
    if (spendableSats == null) {
      const active = getActiveWallet()
      spendableSats = active ? await inUiPhase('recompose-balance', () => fetchBalanceSats(active.wallet)) : 0
    }
    return { spendableSats, chainError: null }
  } catch (err) {
    const chainError = err instanceof Error ? err.message : String(err)
    try {
      const { appendAppLog } = await import('./appLog')
      appendAppLog('warn', `[recompose] chain failed (${reason}): ${chainError}`)
    } catch {
      /* ignore */
    }
    return { spendableSats: null, chainError }
  }
}

const DERIVED_PASS_YIELD_MS = 2_000

/**
 * After every recompose: union the off-device custody journal in, bring back
 * every journaled output a restore or wipe left out, then journal every
 * recipe this store holds. A wipe or an older snapshot deletes the only other
 * copy of those random prefixes/suffixes, and change without them is
 * unspendable forever.
 *
 * Activity rereads every transaction record only when localState was
 * replaced. Each record is cloned whole, and on an unlock that changed nothing
 * that reread ran for minutes and never landed before the app was put away.
 * The read starts beside these passes, not after them: the change echo and
 * journal sweep take minutes on an item wallet, and Activity stayed at the
 * restored copy that whole time. It waits only for a send the user started;
 * an import run holds priority for hours and the passes wait that out, the
 * read does not. A second, incremental read follows them.
 */
function scheduleDerivedChangePass(runtime: WalletRuntime, localStateWasReplaced: boolean): void {
  setTimeout(() => {
    void (async () => {
      const { runtimeIsCurrent } = await import('./walletRuntime')
      const waitOut = async (busy: () => boolean): Promise<boolean> => {
        while (busy() || isRecomposeInFlight()) {
          if (!runtimeIsCurrent(runtime)) return false
          await new Promise((resolve) => setTimeout(resolve, DERIVED_PASS_YIELD_MS))
        }
        return runtimeIsCurrent(runtime)
      }
      if (!(await waitOut(foregroundSpendWaiting))) return
      const { refreshActivityLedger } = await import('./activityLedger')
      const ledgerRead = inUiPhase(localStateWasReplaced ? 'activity-ledger-full' : 'activity-ledger', () =>
        refreshActivityLedger(runtime, { full: localStateWasReplaced }),
      )
      if (!(await waitOut(shouldYieldChainIngestToSpend))) return
      const { syncCustodyJournal } = await import('./custodyJournalBackup')
      await inUiPhase('derived-journal', () => syncCustodyJournal(runtime.instance, 'recompose'))
      if (!runtimeIsCurrent(runtime)) return
      const { echoAllDerivedOutputs, recoverEchoedChange } = await import(
        './reimportDerivedChange'
      )
      const recovered = await inUiPhase('derived-recover', () => recoverEchoedChange(runtime.instance))
      if (!runtimeIsCurrent(runtime)) return
      await inUiPhase('derived-echo', () => echoAllDerivedOutputs(runtime.instance))
      if (recovered.imported > 0) {
        const { bumpBalanceAfterHeal } = await import('./session')
        bumpBalanceAfterHeal()
      }
      await ledgerRead
      if (!runtimeIsCurrent(runtime)) return
      await inUiPhase('activity-ledger', () => refreshActivityLedger(runtime))
    })().catch((err) => {
      console.warn('[derived-change] post-recompose pass failed', err)
    })
  }, 0)
}
