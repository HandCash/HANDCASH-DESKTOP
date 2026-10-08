/**
 * Refresh-time reconcile of default-basket coins storage holds unspendable
 * with no local spender. See `kernel/writtenOffCoinFate.ts` for the rules.
 *
 * Same three-phase contract as `restoreLiveSpendableOutputs`: read storage in
 * one session, ask the chain outside any session, write in one session. It
 * reads the whole unspendable set rather than one page, which is the reach
 * that restore lacks; the per-coin proof before a restore is the same
 * `outpointProvenUnspent` that restore uses.
 */

import { pinnedActiveWallet } from './pinnedWallet'
import { probeOutpointSpends } from './createActionInputFate'
import {
  forgetPromotedLocalChange,
  hideSpentOutpoints,
  outpointProvenUnspent,
} from './staleOutputRelease'
import { getUtxoLock, isUtxoBlockedFromRestore } from './utxoLockManager'
import { isQuarantined } from './utxoLifecycle'
import { hasLockingScript, type ChangeRow } from './changeScriptFate'
import { outpointFromOutput } from './txOutpoints'
import { txLivenessFromStatus } from './kernel/txLiveness'
import {
  decideWrittenOffCoinFate,
  isWrittenOffCandidate,
  type ChainSpendAnswer,
} from './kernel/writtenOffCoinFate'
import { yieldToUi } from './yieldToUi'

/** A full pass reads every unspendable row; once per window is plenty. */
const RECONCILE_EVERY_MS = 10 * 60_000
const MAX_CANDIDATES = 800
const PROBE_BATCH = 60
const PROBE_TIMEOUT_MS = 8_000
/** Per-coin proofs one pass pays for; the rest wait for the next Refresh. */
const MAX_PROOFS = 240
const PROOF_CONCURRENCY = 4

export type WrittenOffReconcileResult = {
  skipped: boolean
  candidates: number
  restored: number
  restoredSats: number
  hidden: number
  hiddenSats: number
  silent: number
}

const SKIPPED: WrittenOffReconcileResult = {
  skipped: true,
  candidates: 0,
  restored: 0,
  restoredSats: 0,
  hidden: 0,
  hiddenSats: 0,
  silent: 0,
}

const lastRunAt = new Map<string, number>()

type OutputRow = ChangeRow & {
  outputId?: number
  transactionId?: number
  spentBy?: number | null
  spendable?: boolean
  satoshis?: number
  txid?: string
  vout?: number
}

type TxRow = { transactionId?: number; status?: string; txid?: string }

type ReconcileStorage = {
  getAuth(): Promise<{ userId?: number }>
  runAsStorageProvider<T>(fn: (sp: ReconcileProvider) => Promise<T>): Promise<T>
}

type ReconcileProvider = {
  findOutputBaskets(args: unknown): Promise<Array<{ basketId: number }>>
  findOutputs(args: unknown): Promise<OutputRow[]>
  findTransactions(args: unknown): Promise<TxRow[]>
  updateOutput(id: number, patch: Record<string, unknown>): Promise<unknown>
}

type Candidate = {
  outputId: number
  outpoint: string
  satoshis: number
  settled: boolean
  hasScript: boolean
}

function positiveId(value: unknown): number | null {
  const n = Number(value)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

function overlayHolds(outpoint: string): boolean {
  if (isUtxoBlockedFromRestore(outpoint)) return true
  const lock = getUtxoLock(outpoint)
  return lock != null && isQuarantined(lock)
}

export async function reconcileWrittenOffCoins(opts?: {
  force?: boolean
  shouldStop?: () => boolean
}): Promise<WrittenOffReconcileResult> {
  const active = pinnedActiveWallet()
  const storage = (active?.wallet as { storage?: Partial<ReconcileStorage> } | undefined)?.storage
  if (!active || typeof storage?.runAsStorageProvider !== 'function' || typeof storage.getAuth !== 'function') {
    return SKIPPED
  }
  const now = Date.now()
  if (!opts?.force && now - (lastRunAt.get(active.identityKey) ?? 0) < RECONCILE_EVERY_MS) return SKIPPED
  const stop = opts?.shouldStop ?? (() => false)
  const started = Date.now()

  const { userId } = await storage.getAuth()
  if (typeof userId !== 'number') return SKIPPED

  const read = await storage.runAsStorageProvider(async (sp) => {
    const [basket] = await sp.findOutputBaskets({ partial: { userId, name: 'default' } })
    if (!basket) return null
    const txs = await sp.findTransactions({ partial: { userId }, noRawTx: true })
    const outputs = await sp.findOutputs({
      partial: { userId, basketId: basket.basketId, spendable: false },
    })
    return { txs, outputs }
  })
  if (!read || stop()) return SKIPPED

  const statusById = new Map<number, string>()
  const localTxids = new Set<string>()
  for (const tx of read.txs) {
    const id = positiveId(tx.transactionId)
    if (id != null) statusById.set(id, String(tx.status ?? ''))
    if (typeof tx.txid === 'string' && tx.txid) localTxids.add(tx.txid.toLowerCase())
  }

  const candidates: Candidate[] = []
  for (const row of read.outputs) {
    const outputId = positiveId(row.outputId)
    const outpoint = outpointFromOutput(row)
    if (outputId == null || outpoint == null) continue
    const creatorId = positiveId(row.transactionId)
    const facts = {
      satoshis: Math.max(0, Math.trunc(Number(row.satoshis) || 0)),
      creator: txLivenessFromStatus(creatorId != null ? statusById.get(creatorId) : undefined),
      spentLocally: positiveId(row.spentBy) != null,
      overlayHeld: overlayHolds(outpoint),
      hasScript: hasLockingScript(row),
    }
    if (!isWrittenOffCandidate(facts)) continue
    candidates.push({
      outputId,
      outpoint,
      satoshis: facts.satoshis,
      settled: facts.creator === 'settled',
      hasScript: facts.hasScript,
    })
    if (candidates.length >= MAX_CANDIDATES) break
  }
  if (candidates.length === 0) {
    lastRunAt.set(active.identityKey, now)
    return { ...SKIPPED, skipped: false }
  }

  const answers = new Map<string, ChainSpendAnswer>()
  for (let i = 0; i < candidates.length && !stop(); i += PROBE_BATCH) {
    const batch = candidates.slice(i, i + PROBE_BATCH).map((c) => c.outpoint)
    const probes = await probeOutpointSpends(batch, '', active.chain, PROBE_TIMEOUT_MS)
    for (const [outpoint, probe] of probes) {
      answers.set(
        outpoint,
        probe.kind === 'spent'
          ? { kind: 'spent', spender: probe.spender, spenderIsLocal: localTxids.has(probe.spender.toLowerCase()) }
          : probe,
      )
    }
    await yieldToUi()
  }

  const toRestore: Candidate[] = []
  const toHide = new Map<string, Candidate[]>()
  let silent = 0
  for (const c of candidates) {
    const fate = decideWrittenOffCoinFate(
      {
        satoshis: c.satoshis,
        creator: c.settled ? 'settled' : 'pending',
        spentLocally: false,
        overlayHeld: false,
        hasScript: c.hasScript,
      },
      answers.get(c.outpoint) ?? { kind: 'unknown' },
    )
    if (fate.kind === 'restore') toRestore.push(c)
    else if (fate.kind === 'hide') toHide.set(fate.spender, [...(toHide.get(fate.spender) ?? []), c])
    else if (fate.reason === 'chainSilent') silent += 1
  }

  const proven: Candidate[] = []
  const proving = toRestore.slice(0, MAX_PROOFS)
  for (let i = 0; i < proving.length && !stop(); i += PROOF_CONCURRENCY) {
    const batch = proving.slice(i, i + PROOF_CONCURRENCY)
    const verdicts = await Promise.all(batch.map((c) => outpointProvenUnspent(active, c.outpoint)))
    batch.forEach((c, j) => {
      if (verdicts[j]) proven.push(c)
    })
    await yieldToUi()
  }

  let restored = 0
  let restoredSats = 0
  if (proven.length > 0) {
    await storage.runAsStorageProvider(async (sp) => {
      for (const c of proven) {
        // A send may have claimed the coin since the read; only an untouched row flips.
        const [row] = await sp.findOutputs({ partial: { outputId: c.outputId }, noScript: true })
        if (!row || row.spendable === true || positiveId(row.spentBy) != null) continue
        if (overlayHolds(c.outpoint)) continue
        await sp.updateOutput(c.outputId, { spendable: true })
        restored += 1
        restoredSats += c.satoshis
      }
    })
    if (restored > 0) forgetPromotedLocalChange()
  }

  let hidden = 0
  let hiddenSats = 0
  for (const [spender, coins] of toHide) {
    if (stop()) break
    await hideSpentOutpoints(
      coins.map((c) => c.outpoint),
      spender,
      active,
    )
    hidden += coins.length
    hiddenSats += coins.reduce((sum, c) => sum + c.satoshis, 0)
  }

  if (restored > 0 || hidden > 0) {
    const { bumpBalanceAfterHeal } = await import('./session')
    bumpBalanceAfterHeal()
  }

  // A pass a send cut short is not a finished pass; the next Refresh resumes it.
  if (!stop()) lastRunAt.set(active.identityKey, now)

  const result: WrittenOffReconcileResult = {
    skipped: false,
    candidates: candidates.length,
    restored,
    restoredSats,
    hidden,
    hiddenSats,
    silent,
  }
  const ms = Date.now() - started
  if (ms >= 250 || restored > 0 || hidden > 0) {
    console.info(
      `[written-off] reconcile done ${ms}ms — candidates=${candidates.length} restored=${restored} sats=${restoredSats} hidden=${hidden} hiddenSats=${hiddenSats} spenders=${toHide.size} silent=${silent} unproven=${toRestore.length - proven.length}`,
    )
  }
  return result
}

export function resetWrittenOffReconcileForTests(): void {
  lastRunAt.clear()
}
