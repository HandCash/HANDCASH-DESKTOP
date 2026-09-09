/**
 * Reconcile local toolbox UTXOs from Activity + live/failed toolbox rows.
 * Do not scrape the app-log ring — that is 800+ lines of support noise, not a
 * UTXO index. Checkpoint remembers already-healed txids so we do not re-probe
 * them. Auto/checkpoint passes are silent; manual writes Activity only when
 * sats move or the pass fails.
 */
import {
  collectActivityTxids,
  recordWalletEvent,
  UTXO_HEAL_METHOD,
  WALLET_ACTIVITY_ORIGIN,
} from './appActivity'
import { runChangeHeal, type ChangeHealStats } from './chainedChangeHeal'
import { logDiag, snapshotWalletBalance } from './diagnosticLog'
import { txExistsOnChain } from './legacyScan'
import { bumpBalanceAfterHeal, getActiveWallet } from './session'
import type { Chain } from './vault'
import { releaseSpendAttemptFunds } from './spendAttempt'
import {
  failUnsentLocalTx,
  keepChangeOfSignedTx,
  listFailedLocalTxids,
  listPendingLocalChangeTxids,
  restoreOnChainLocalTx,
} from './staleOutputRelease'
import {
  appendHealCheckpointBatch,
  healCheckpointFresh,
  HEAL_TXID_BATCH_SIZE,
  readHealCheckpoint,
  txidsMissingFromCheckpoint,
  writeHealCheckpoint,
  type UtxoHealCheckpointSource,
} from './utxoHealCheckpoint'

let utxoHealDepth = 0

/** True while any UTXO heal pass holds the chain-ingest region. */
export function isUtxoHealRunning(): boolean {
  return utxoHealDepth > 0
}

export type UtxoHealBalanceSnapshot = {
  spendable: number
  pendingChange: number
  displayed: number
}

export type UtxoHealPassOpts = {
  source: UtxoHealCheckpointSource
  /** Manual Settings heal — always runs, may write Activity. */
  force?: boolean
}

export type UtxoHealFromHistoryResult = {
  skipped: boolean
  activityRows: number
  archivedRows: number
  txidsChecked: number
  txidsOnChain: number
  changeKept: number
  heal: ChangeHealStats
  recoveredSats: number
  balanceBefore: UtxoHealBalanceSnapshot | null
  balanceAfter: UtxoHealBalanceSnapshot | null
}

function toBalanceSnapshot(
  snap: Awaited<ReturnType<typeof snapshotWalletBalance>>,
): UtxoHealBalanceSnapshot | null {
  if (snap.spendable == null || snap.displayed == null) return null
  return {
    spendable: snap.spendable,
    pendingChange: snap.pendingChange ?? snap.displayed - snap.spendable,
    displayed: snap.displayed,
  }
}

function mergeHealStats(a: ChangeHealStats, b: ChangeHealStats): ChangeHealStats {
  return {
    restored: a.restored + b.restored,
    scriptsLocal: a.scriptsLocal + b.scriptsLocal,
    scriptsChain: a.scriptsChain + b.scriptsChain,
    pendingPromoted: a.pendingPromoted + b.pendingPromoted,
    reclaimed: a.reclaimed + b.reclaimed,
  }
}

export function formatUtxoHealResult(result: UtxoHealFromHistoryResult): string {
  if (result.skipped) return 'Balance heal is current'
  if (result.recoveredSats > 0) {
    return `Recovered ${result.recoveredSats.toLocaleString()} sats`
  }
  if (result.heal.pendingPromoted > 0 || result.heal.restored > 0) {
    return 'Promoted stuck change'
  }
  if (result.txidsChecked > 0) {
    return `Checked ${result.txidsChecked} txid(s) — nothing to heal`
  }
  return 'Nothing to heal'
}

function collectCandidateTxids(): {
  txids: Set<string>
  activity: ReturnType<typeof collectActivityTxids>
} {
  const activity = collectActivityTxids()
  return { txids: activity.txids, activity }
}

function orderTxidsForHeal(args: {
  missing: string[]
  pendingLive: string[]
  failed: string[]
  activity: Iterable<string>
  includeActivity: boolean
}): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const push = (txid: string) => {
    const id = txid.toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(id) || seen.has(id)) return
    seen.add(id)
    out.push(id)
  }
  for (const txid of args.pendingLive) push(txid)
  for (const txid of args.failed) push(txid)
  for (const txid of args.missing) push(txid)
  if (args.includeActivity) {
    for (const txid of args.activity) push(txid)
  }
  return out
}

async function hasLocalSignedTx(txid: string): Promise<boolean> {
  const storage = getActiveWallet()?.wallet?.storage
  if (!storage?.runAsStorageProvider) return false
  try {
    return await storage.runAsStorageProvider(async (activeSp) => {
      const sp = activeSp as {
        getProvenOrRawTx?: (id: string) => Promise<{ rawTx?: number[] } | undefined>
      }
      if (typeof sp.getProvenOrRawTx !== 'function') return false
      const found = await sp.getProvenOrRawTx(txid)
      return Array.isArray(found?.rawTx) && found.rawTx.length > 0
    })
  } catch {
    return false
  }
}

async function healShouldYieldToSpend(_opts: UtxoHealPassOpts): Promise<boolean> {
  // Manual heal used to refuse yield and held chainIngest for minutes while
  // burns/sends timed out ("Wallet is busy · spend waiting"). Checkpoint +
  // auto resume cover the rest of the txid list after the spend finishes.
  const { shouldYieldChainIngestToSpend, getSpendPriorityDepth } = await import(
    './walletCoordinator'
  )
  return shouldYieldChainIngestToSpend() || getSpendPriorityDepth() > 0
}

async function runPendingChangeHeal(
  balanceBefore: UtxoHealBalanceSnapshot | null,
  opts: UtxoHealPassOpts,
): Promise<ChangeHealStats> {
  const empty: ChangeHealStats = {
    restored: 0,
    scriptsLocal: 0,
    scriptsChain: 0,
    pendingPromoted: 0,
    reclaimed: 0,
  }
  if (await healShouldYieldToSpend(opts)) return empty

  let heal = await runChangeHeal({ path: 'spendGate' })
  if (await healShouldYieldToSpend(opts)) return heal

  const pending = balanceBefore?.pendingChange ?? 0
  if (pending <= 0) return heal
  // spendGate already paged unspendable change. Extra restore / script-sweep
  // passes are only for leftover pending credit — not a second copy of the
  // same 200-row scan (hc-a580a: 21s + 20s restoreLiveSpendableOutputs).
  if (heal.pendingPromoted === 0 && heal.restored === 0) {
    heal = mergeHealStats(heal, await runChangeHeal({ path: 'spendGatePartialRetry' }))
    if (await healShouldYieldToSpend(opts)) return heal
  }
  heal = mergeHealStats(heal, await runChangeHeal({ path: 'chainingScriptHeal' }))
  return heal
}

async function processTxidBatch(
  batch: string[],
  chain: Chain | undefined,
  failed: Set<string>,
): Promise<{ changeKept: number; txidsOnChain: number; processed: string[] }> {
  let changeKept = 0
  let txidsOnChain = 0
  const processed: string[] = []
  for (const txid of batch) {
    processed.push(txid)
    const local = await hasLocalSignedTx(txid)
    if (chain) {
      const onChain = await txExistsOnChain(txid, chain).catch(() => null)
      if (onChain === false) {
        // Explorer "not on chain" is not a ghost after a successful submit.
        // failUnsent refuses live unmined/sending rows; keep their change.
        if (local) {
          const markedFailed = await failUnsentLocalTx(txid)
          if (!markedFailed) changeKept += await keepChangeOfSignedTx(txid)
        }
        continue
      }
      if (onChain === true) {
        txidsOnChain += 1
        if (failed.has(txid)) await restoreOnChainLocalTx(txid)
      } else if (!local) {
        continue
      }
    } else if (!local) {
      continue
    }
    changeKept += await keepChangeOfSignedTx(txid)
  }
  return { changeKept, txidsOnChain, processed }
}

async function runHealCore(
  orderedTxids: string[],
  balanceBefore: UtxoHealBalanceSnapshot | null,
  failed: Set<string>,
  opts: UtxoHealPassOpts,
): Promise<{
  changeKept: number
  txidsOnChain: number
  heal: ChangeHealStats
  balanceAfter: UtxoHealBalanceSnapshot | null
  recoveredSats: number
  txidsChecked: number
}> {
  if (await healShouldYieldToSpend(opts)) {
    logDiag('utxo-heal', 'info', 'yield-to-spend', { phase: 'before-release' })
    bumpBalanceAfterHeal()
    const balanceAfter = toBalanceSnapshot(await snapshotWalletBalance())
    return {
      changeKept: 0,
      txidsOnChain: 0,
      heal: {
        restored: 0,
        scriptsLocal: 0,
        scriptsChain: 0,
        pendingPromoted: 0,
        reclaimed: 0,
      },
      balanceAfter,
      recoveredSats: 0,
      txidsChecked: 0,
    }
  }

  // This repair can hold toolbox storage while it reviews old unsigned rows.
  // Never start it after a send has raised priority: the payment owns the next
  // storage turn, and the checkpoint scheduler will resume this heal afterward.
  await releaseSpendAttemptFunds()

  if (await healShouldYieldToSpend(opts)) {
    logDiag('utxo-heal', 'info', 'yield-to-spend', { phase: 'after-release' })
    bumpBalanceAfterHeal()
    const balanceAfter = toBalanceSnapshot(await snapshotWalletBalance())
    return {
      changeKept: 0,
      txidsOnChain: 0,
      heal: {
        restored: 0,
        scriptsLocal: 0,
        scriptsChain: 0,
        pendingPromoted: 0,
        reclaimed: 0,
      },
      balanceAfter,
      recoveredSats: 0,
      txidsChecked: 0,
    }
  }

  let heal = await runPendingChangeHeal(balanceBefore, opts)

  const chain = getActiveWallet()?.chain
  let changeKept = 0
  let txidsOnChain = 0
  let txidsChecked = 0
  const allProcessed: string[] = []
  const runAllBatches = opts.force || opts.source === 'manual'

  for (let offset = 0; offset < orderedTxids.length; ) {
    if (await healShouldYieldToSpend(opts)) {
      logDiag('utxo-heal', 'info', 'yield-to-spend', {
        checked: txidsChecked,
        remaining: orderedTxids.length - offset,
      })
      break
    }
    const batch = orderedTxids.slice(offset, offset + HEAL_TXID_BATCH_SIZE)
    if (batch.length === 0) break
    offset += batch.length

    const batchResult = await processTxidBatch(batch, chain, failed)
    changeKept += batchResult.changeKept
    txidsOnChain += batchResult.txidsOnChain
    txidsChecked += batchResult.processed.length
    allProcessed.push(...batchResult.processed)

    bumpBalanceAfterHeal()
    const mid = toBalanceSnapshot(await snapshotWalletBalance())
    appendHealCheckpointBatch(batchResult.processed, {
      pendingChangeAfter: mid?.pendingChange ?? 0,
      recoveredSats:
        balanceBefore && mid
          ? Math.max(0, mid.spendable - balanceBefore.spendable)
          : 0,
      source: opts.source,
    })

    if ((mid?.pendingChange ?? 0) <= 0 && (balanceBefore?.pendingChange ?? 0) > 0) {
      heal = mergeHealStats(heal, await runChangeHeal({ path: 'spendGatePartialRetry' }))
      break
    }
    if (!runAllBatches) break
  }

  if (
    (balanceBefore?.pendingChange ?? 0) > 0 &&
    !(await healShouldYieldToSpend(opts))
  ) {
    heal = mergeHealStats(heal, await runChangeHeal({ path: 'spendGatePartialRetry' }))
  }

  bumpBalanceAfterHeal()
  const balanceAfter = toBalanceSnapshot(await snapshotWalletBalance())
  const recoveredSats =
    balanceBefore && balanceAfter
      ? Math.max(0, balanceAfter.spendable - balanceBefore.spendable)
      : 0

  writeHealCheckpoint({
    at: Date.now(),
    txids: [...new Set([...(readHealCheckpoint()?.txids ?? []), ...allProcessed])],
    recoveredSats,
    pendingChangeAfter: balanceAfter?.pendingChange ?? 0,
    source: opts.source,
  })

  return { changeKept, txidsOnChain, heal, balanceAfter, recoveredSats, txidsChecked }
}

/**
 * One heal pass. Activity + toolbox rows are the candidate set; the checkpoint
 * is only a skip list (already healed), never a work list of old hashes.
 */
export async function runUtxoHealPass(
  opts: UtxoHealPassOpts,
): Promise<UtxoHealFromHistoryResult> {
  const { txids, activity } = collectCandidateTxids()
  const balanceBefore = toBalanceSnapshot(await snapshotWalletBalance())
  const missing = txidsMissingFromCheckpoint(txids)
  const pendingChange = balanceBefore?.pendingChange ?? 0
  const checkpointed = new Set(
    (readHealCheckpoint()?.txids ?? []).map((t) => t.toLowerCase()),
  )
  const allFailed = await listFailedLocalTxids()
  const includeActivity = opts.force === true || opts.source === 'manual'
  const failedTxids = includeActivity
    ? allFailed
    : allFailed.filter((id) => !checkpointed.has(id))

  const shouldSkip =
    !includeActivity &&
    healCheckpointFresh() &&
    missing.length === 0 &&
    pendingChange <= 0 &&
    failedTxids.length === 0

  if (shouldSkip) {
    const cp = readHealCheckpoint()
    return {
      skipped: true,
      activityRows: activity.total,
      archivedRows: activity.archived,
      txidsChecked: cp?.txids.length ?? 0,
      txidsOnChain: 0,
      changeKept: 0,
      heal: {
        restored: 0,
        scriptsLocal: 0,
        scriptsChain: 0,
        pendingPromoted: 0,
        reclaimed: 0,
      },
      recoveredSats: 0,
      balanceBefore,
      balanceAfter: balanceBefore,
    }
  }

  const txidList = orderTxidsForHeal({
    missing,
    pendingLive: pendingChange > 0 ? await listPendingLocalChangeTxids() : [],
    failed: failedTxids,
    activity: txids,
    includeActivity,
  })

  logDiag('utxo-heal', 'info', 'start', {
    source: opts.source,
    force: opts.force === true,
    txids: txidList.length,
    missing: missing.length,
    pendingChange,
    failed: failedTxids.length,
    batchSize: HEAL_TXID_BATCH_SIZE,
  })

  const { runChainIngest } = await import('./walletCoordinator')
  return runChainIngest(async () => {
    utxoHealDepth += 1
    try {
      const core = await runHealCore(
        txidList,
        balanceBefore,
        new Set(failedTxids),
        opts,
      )
      const pendingChangeAfter = core.balanceAfter?.pendingChange ?? 0

      const result: UtxoHealFromHistoryResult = {
        skipped: false,
        activityRows: activity.total,
        archivedRows: activity.archived,
        txidsChecked: core.txidsChecked,
        txidsOnChain: core.txidsOnChain,
        changeKept: core.changeKept,
        heal: core.heal,
        recoveredSats: core.recoveredSats,
        balanceBefore,
        balanceAfter: core.balanceAfter,
      }

      if (
        opts.source === 'manual' &&
        (core.recoveredSats > 0 || pendingChangeAfter > 0)
      ) {
        recordWalletEvent({
          origin: WALLET_ACTIVITY_ORIGIN,
          method: UTXO_HEAL_METHOD,
          sats: core.recoveredSats,
          note:
            core.recoveredSats > 0
              ? `Recovered ${core.recoveredSats.toLocaleString()} sats`
              : formatUtxoHealResult(result),
          status: 'complete',
        })
      }

      logDiag('utxo-heal', 'info', 'done', {
        source: opts.source,
        txidsChecked: result.txidsChecked,
        recoveredSats: core.recoveredSats,
        pendingChangeAfter,
      })

      return result
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      if (opts.source === 'manual') {
        recordWalletEvent({
          origin: WALLET_ACTIVITY_ORIGIN,
          method: UTXO_HEAL_METHOD,
          note: 'Balance heal failed',
          status: 'failed',
          failureReason: reason,
        })
      }
      logDiag('utxo-heal', 'warn', 'failed', { source: opts.source, reason })
      throw err
    } finally {
      utxoHealDepth = Math.max(0, utxoHealDepth - 1)
    }
  })
}

/** Settings → Wallet health manual heal. */
let manualHealFlight: Promise<UtxoHealFromHistoryResult> | null = null

export async function healUtxoFromActivityHistory(): Promise<UtxoHealFromHistoryResult> {
  if (manualHealFlight) return manualHealFlight
  manualHealFlight = runUtxoHealPass({ source: 'manual', force: true }).finally(() => {
    manualHealFlight = null
  })
  return manualHealFlight
}

/**
 * Auto UTXO heal is Settings-only. Background checkpoint used to take
 * `runChainIngest` (merkle proofs, 13+ activity txids) and block sends /
 * Collect listOutputs. Callers may still invoke this; it does nothing.
 */
export function scheduleHealCheckpointIfDue(_reason: UtxoHealCheckpointSource): void {
  return
}
