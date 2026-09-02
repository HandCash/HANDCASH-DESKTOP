/**
 * Reconcile local toolbox UTXOs using Activity + session logs, then run explicit
 * change-heal paths. Does not invent spend routes — only promotes outputs the
 * wallet already created or logged.
 */
import { collectActivityTxids } from './appActivity'
import { getAppLogs, getPreviousSessionLogs } from './appLog'
import { runChangeHeal, type ChangeHealStats } from './chainedChangeHeal'
import { logDiag, snapshotWalletBalance } from './diagnosticLog'
import { txExistsOnChain } from './legacyScan'
import { bumpBalanceAfterHeal, getActiveWallet } from './session'
import { releaseSpendAttemptFunds } from './spendAttempt'
import { keepChangeOfSignedTx } from './staleOutputRelease'

const TXID_RE = /\b([0-9a-f]{64})\b/gi

export type UtxoHealBalanceSnapshot = {
  spendable: number
  pendingChange: number
  displayed: number
}

export type UtxoHealFromHistoryResult = {
  activityRows: number
  archivedRows: number
  txidsFromActivity: number
  txidsFromLogs: number
  txidsChecked: number
  txidsOnChain: number
  changeKept: number
  heal: ChangeHealStats
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

/**
 * Scan Activity (including archived rows) and recent session logs for signed
 * txids, release stuck reservations, credit change, then run change-heal paths.
 */
export async function healUtxoFromActivityHistory(): Promise<UtxoHealFromHistoryResult> {
  const balanceBefore = toBalanceSnapshot(await snapshotWalletBalance())
  const activity = collectActivityTxids()
  const fromLogs = extractTxidsFromLogs()
  const txids = new Set<string>([...activity.txids, ...fromLogs])

  logDiag('utxo-heal', 'info', 'start', {
    activityRows: activity.total,
    archivedRows: activity.archived,
    txidsFromActivity: activity.txids.size,
    txidsFromLogs: fromLogs.size,
  })

  await releaseSpendAttemptFunds()

  const chain = getActiveWallet()?.chain
  let txidsOnChain = 0
  let changeKept = 0

  for (const txid of txids) {
    if (chain) {
      const onChain = await txExistsOnChain(txid, chain).catch(() => null)
      if (onChain !== true) continue
      txidsOnChain += 1
    }
    changeKept += await keepChangeOfSignedTx(txid)
  }

  let heal = await runChangeHeal({ path: 'spendGate' })
  if (
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

  const result: UtxoHealFromHistoryResult = {
    activityRows: activity.total,
    archivedRows: activity.archived,
    txidsFromActivity: activity.txids.size,
    txidsFromLogs: fromLogs.size,
    txidsChecked: txids.size,
    txidsOnChain,
    changeKept,
    heal,
    balanceBefore,
    balanceAfter,
  }

  logDiag('utxo-heal', 'info', 'done', {
    txidsChecked: result.txidsChecked,
    txidsOnChain: result.txidsOnChain,
    changeKept: result.changeKept,
    pendingPromoted: heal.pendingPromoted,
    restored: heal.restored,
    scriptsLocal: heal.scriptsLocal,
    scriptsChain: heal.scriptsChain,
    reclaimed: heal.reclaimed,
    spendableBefore: balanceBefore?.spendable ?? null,
    spendableAfter: balanceAfter?.spendable ?? null,
  })

  return result
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

/** One-line summary for Settings UI. */
export function formatUtxoHealResult(result: UtxoHealFromHistoryResult): string {
  const parts: string[] = []
  if (result.changeKept > 0) parts.push(`${result.changeKept} change output(s) credited`)
  if (result.heal.pendingPromoted > 0) {
    parts.push(`${result.heal.pendingPromoted} pending change promoted`)
  }
  if (result.heal.restored > 0) parts.push(`${result.heal.restored} output(s) restored`)
  if (result.heal.scriptsLocal > 0 || result.heal.scriptsChain > 0) {
    parts.push(
      `${result.heal.scriptsLocal + result.heal.scriptsChain} script(s) healed`,
    )
  }
  if (result.heal.reclaimed > 0) {
    parts.push(`${result.heal.reclaimed} sealed input(s) reclaimed`)
  }
  if (result.balanceBefore && result.balanceAfter) {
    const delta = result.balanceAfter.spendable - result.balanceBefore.spendable
    if (delta > 0) parts.push(`+${delta} spendable sats`)
    else if (delta < 0) parts.push(`${delta} spendable sats`)
  }
  if (parts.length === 0) {
    return `Scanned ${result.txidsChecked} txid(s) from history — nothing to heal`
  }
  return parts.join(' · ')
}
