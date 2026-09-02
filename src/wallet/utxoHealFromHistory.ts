/**
 * Reconcile local toolbox UTXOs from Activity + logs + checkpoint txids.
 * Auto/checkpoint passes are silent (like consolidateChange); manual writes
 * Activity only when sats move or the pass fails.
 */
import {
  collectActivityTxids,
  recordWalletEvent,
  UTXO_HEAL_METHOD,
  WALLET_ACTIVITY_ORIGIN,
} from './appActivity'
import { getAppLogs, getPreviousSessionLogs } from './appLog'
import { runChangeHeal, type ChangeHealStats } from './chainedChangeHeal'
import { logDiag, snapshotWalletBalance } from './diagnosticLog'
import { txExistsOnChain } from './legacyScan'
import { bumpBalanceAfterHeal, getActiveWallet } from './session'
import { releaseSpendAttemptFunds } from './spendAttempt'
import { keepChangeOfSignedTx } from './staleOutputRelease'
import {
  canRunAutoHealCheckpoint,
  healCheckpointFresh,
  markAutoHealAttempt,
  mergeTxidsWithCheckpoint,
  readHealCheckpoint,
  txidsMissingFromCheckpoint,
  writeHealCheckpoint,
  type UtxoHealCheckpointSource,
} from './utxoHealCheckpoint'

const TXID_RE = /\b([0-9a-f]{64})\b/gi

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

function extractTxidsFromLogs(): Set<string> {
  const out = new Set<string>()
  const interesting =
    /\btxid=|\btxid\b|createAction|postBeef|stale-output|spend-attempt|keep change/i
  const scan = (message: string) => {
    if (!interesting.test(message)) return
    for (const match of message.matchAll(TXID_RE)) {
      out.add(match[1]!.toLowerCase())
    }
  }
  for (const entry of getPreviousSessionLogs()) scan(entry.message)
  for (const entry of getAppLogs()) scan(entry.message)
  return out
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
  fromLogs: number
} {
  const activity = collectActivityTxids()
  const fromLogs = extractTxidsFromLogs()
  const txids = mergeTxidsWithCheckpoint(
    new Set([...activity.txids, ...fromLogs]),
  )
  return { txids, activity, fromLogs: fromLogs.size }
}

async function runHealCore(
  txidList: string[],
  balanceBefore: UtxoHealBalanceSnapshot | null,
  deepHeal: boolean,
): Promise<{
  changeKept: number
  txidsOnChain: number
  heal: ChangeHealStats
  balanceAfter: UtxoHealBalanceSnapshot | null
  recoveredSats: number
}> {
  await releaseSpendAttemptFunds()

  const chain = getActiveWallet()?.chain
  let txidsOnChain = 0
  let changeKept = 0

  for (const txid of txidList) {
    if (chain) {
      const onChain = await txExistsOnChain(txid, chain).catch(() => null)
      if (onChain !== true) continue
      txidsOnChain += 1
    }
    changeKept += await keepChangeOfSignedTx(txid)
  }

  let heal = await runChangeHeal({ path: 'spendGate' })
  if (
    deepHeal &&
    heal.pendingPromoted === 0 &&
    heal.restored === 0 &&
    heal.reclaimed === 0
  ) {
    heal = mergeHealStats(heal, await runChangeHeal({ path: 'chainingScriptHeal' }))
  }
  if (balanceBefore != null && balanceBefore.pendingChange > 0) {
    heal = mergeHealStats(
      heal,
      await runChangeHeal({ path: 'spendGatePartialRetry' }),
    )
  }

  bumpBalanceAfterHeal()
  const balanceAfter = toBalanceSnapshot(await snapshotWalletBalance())
  const recoveredSats =
    balanceBefore && balanceAfter
      ? Math.max(0, balanceAfter.spendable - balanceBefore.spendable)
      : 0

  return { changeKept, txidsOnChain, heal, balanceAfter, recoveredSats }
}

/**
 * One heal pass. Checkpoint txids are always merged so prior work is never lost.
 */
export async function runUtxoHealPass(
  opts: UtxoHealPassOpts,
): Promise<UtxoHealFromHistoryResult> {
  const { txids, activity, fromLogs } = collectCandidateTxids()
  const balanceBefore = toBalanceSnapshot(await snapshotWalletBalance())
  const missing = txidsMissingFromCheckpoint(txids)
  const pendingChange = balanceBefore?.pendingChange ?? 0

  const shouldSkip =
    !opts.force &&
    opts.source !== 'manual' &&
    healCheckpointFresh() &&
    missing.length === 0 &&
    pendingChange <= 0

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

  const txidList = [...txids]
  const deepHeal = opts.force || opts.source === 'manual' || pendingChange > 0

  logDiag('utxo-heal', 'info', 'start', {
    source: opts.source,
    force: opts.force === true,
    txids: txidList.length,
    missing: missing.length,
    pendingChange,
  })

  try {
    const core = await runHealCore(txidList, balanceBefore, deepHeal)
    const pendingChangeAfter = core.balanceAfter?.pendingChange ?? 0

    writeHealCheckpoint({
      at: Date.now(),
      txids: txidList,
      recoveredSats: core.recoveredSats,
      pendingChangeAfter,
      source: opts.source,
    })

    const result: UtxoHealFromHistoryResult = {
      skipped: false,
      activityRows: activity.total,
      archivedRows: activity.archived,
      txidsChecked: txidList.length,
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
  }
}

/** Settings → Wallet health manual heal. */
let manualHealFlight: Promise<UtxoHealFromHistoryResult> | null = null

export function isUtxoHealRunning(): boolean {
  return manualHealFlight != null
}

export async function healUtxoFromActivityHistory(): Promise<UtxoHealFromHistoryResult> {
  if (manualHealFlight) return manualHealFlight
  manualHealFlight = runUtxoHealPass({ source: 'manual', force: true }).finally(() => {
    manualHealFlight = null
  })
  return manualHealFlight
}

/** Silent checkpoint pass — send cleanup, pending-change background, unlock tail. */
export function scheduleHealCheckpointIfDue(reason: UtxoHealCheckpointSource): void {
  void (async () => {
    if (!canRunAutoHealCheckpoint()) return
    markAutoHealAttempt()
    try {
      const before = toBalanceSnapshot(await snapshotWalletBalance())
      const pending = before?.pendingChange ?? 0
      const { txids } = collectCandidateTxids()
      if (
        healCheckpointFresh() &&
        pending <= 0 &&
        txidsMissingFromCheckpoint(txids).length === 0
      ) {
        return
      }
      await runUtxoHealPass({ source: reason })
    } catch (err) {
      console.warn('[utxo-heal] checkpoint pass skipped', reason, err)
    }
  })()
}
