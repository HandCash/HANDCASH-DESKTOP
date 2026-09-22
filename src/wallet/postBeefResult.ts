import { getActiveWallet } from './session'

/**
 * Interpret toolbox `postBeef` / `postRaws` results.
 *
 * Top-level `status: 'error'` is not enough — Bitails marks missing-inputs as
 * error+doubleSpend, while already-in-mempool stays success on the txid row.
 */
import { spentStatusOfOutpoint, txExistsOnChain } from './legacyScan'
import type { Chain } from './vault'
import { inputOutpointsForSignedTx } from './signedTxInputs'
import { normalizeTxid } from './txid'

export type PostBeefServiceResult = {
  name?: string
  status?: string
  txidResults?: Array<{
    txid?: string
    status?: string
    alreadyKnown?: boolean
    doubleSpend?: boolean
    competingTxs?: string[]
    serviceError?: boolean
    notes?: Array<{ what?: string; message?: string; code?: unknown }>
    data?: unknown
  }>
  error?: { message?: string }
}

export type PostBeefSummary = {
  accepted: boolean
  doubleSpend: boolean
  missingInputs: boolean
  serviceOnlyErrors: boolean
  detail: string
  competingTxs: string[]
}

type TxidRow = NonNullable<PostBeefServiceResult['txidResults']>[number]

function noteWhat(notes: Array<{ what?: string }> | undefined): string[] {
  return (notes ?? []).map((n) => String(n.what ?? '')).filter(Boolean)
}

function dataMessage(data: unknown): string {
  if (!data || typeof data !== 'object') return ''
  return String((data as { message?: string }).message ?? '')
}

export function isArcadeNamedService(name?: string): boolean {
  return String(name ?? '').toLowerCase().includes('arcade')
}

export function txidRowLooksAccepted(t: TxidRow): boolean {
  if (t.status === 'success' || t.alreadyKnown) return true
  return noteWhat(t.notes).some((w) => /AlreadyInMempool/i.test(w))
}

function txidRowLooksMissingInputs(t: TxidRow): boolean {
  if (noteWhat(t.notes).some((w) => /MissingInputs/i.test(w))) return true
  return /missing.?input/i.test(dataMessage(t.data))
}

/**
 * Hard reject needs *evidence* — a doubleSpend flag or a note/message naming the
 * defect. A bare `status: 'error'` row is an unexplained provider answer (down,
 * rate-limited, policy). Treating it as proof used to drop a live local spend and
 * report it as "Already spent".
 */
function txidRowLooksHardReject(t: TxidRow): boolean {
  if (t.doubleSpend) return true
  const status = String(t.status ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_')
  if (
    status === 'UTXO_SPENT' ||
    status === 'MISSING_INPUTS' ||
    status === 'PARENT_REJECTED' ||
    status === 'INVALID' ||
    status === 'REJECTED'
  ) {
    return true
  }
  if (
    noteWhat(t.notes).some((w) =>
      /MissingInputs|AlreadySpent|UTXO.?SPENT|Parent.?Rejected|Invalid|not.?found/i.test(w),
    )
  ) {
    return true
  }
  return (
    t.status === 'error' &&
    /missing.?input|already.?spent|utxo.?spent|parent.?rejected|invalid/i.test(
      dataMessage(t.data),
    )
  )
}

export function postBeefResultsHitArcade(
  results: PostBeefServiceResult[] | null | undefined,
): boolean {
  if (!Array.isArray(results)) return false
  return results.some((r) => isArcadeNamedService(r.name))
}

/**
 * Arcade POST success is send completion — do not wait on explorers / merkle.
 * Matches arcadeV2: 202 / success / alreadyKnown on an Arcade-named service.
 */
export function postBeefResultsArcadeAccepted(
  results: PostBeefServiceResult[] | null | undefined,
): boolean {
  if (!Array.isArray(results)) return false
  // An HTTP/service-level success only says Arcade answered. An explicit tx
  // verdict is authoritative and must never be overwritten by that envelope.
  for (const r of results) {
    if (!isArcadeNamedService(r.name)) continue
    if ((r.txidResults ?? []).some(txidRowLooksHardReject)) return false
  }
  for (const r of results) {
    if (!isArcadeNamedService(r.name)) continue
    for (const t of r.txidResults ?? []) {
      if (txidRowLooksAccepted(t)) return true
    }
    if (
      (r.txidResults?.length ?? 0) === 0 &&
      String(r.status ?? '').toLowerCase() === 'success'
    ) {
      return true
    }
  }
  return false
}

/**
 * Arcade hard-reject for invalid / missing inputs — drop local change immediately.
 * Do not wait on explorers; do not pin the tx as "Arcade submitted".
 *
 * Requires an explicit defect on a txid row. An Arcade service that merely
 * errored (or answered nothing) is a delivery failure, not a verdict.
 */
export function postBeefResultsArcadeHardReject(
  results: PostBeefServiceResult[] | null | undefined,
): boolean {
  if (!Array.isArray(results)) return false
  if (postBeefResultsArcadeAccepted(results)) return false
  for (const r of results) {
    if (!isArcadeNamedService(r.name)) continue
    const rows = r.txidResults ?? []
    for (const t of rows) {
      if (txidRowLooksHardReject(t)) return true
    }
  }
  return false
}

export function summarizePostBeef(
  results: PostBeefServiceResult[] | null | undefined,
): PostBeefSummary {
  if (!Array.isArray(results)) {
    return {
      accepted: false,
      doubleSpend: false,
      missingInputs: false,
      serviceOnlyErrors: true,
      detail: 'no services',
      competingTxs: [],
    }
  }
  let accepted = false
  let doubleSpend = false
  let missingInputs = false
  let anyTxRow = false
  let anyServiceError = false
  const competing = new Set<string>()
  const parts: string[] = []

  for (const r of results) {
    const name = r.name || 'service'
    // Reasons, not just statuses. "arcade:error" alone could not distinguish an
    // incomplete BEEF from a spent input when reading a support log.
    const reasons = new Set<string>()
    for (const t of r.txidResults ?? []) {
      for (const what of noteWhat(t.notes)) reasons.add(what)
      const msg = dataMessage(t.data)
      if (msg) reasons.add(msg.slice(0, 80))
    }
    if (r.error?.message) reasons.add(r.error.message.slice(0, 80))
    const why = reasons.size > 0 ? `(${[...reasons].slice(0, 2).join('; ')})` : ''
    parts.push(`${name}:${r.status || 'unknown'}${why}`)
    for (const t of r.txidResults ?? []) {
      anyTxRow = true
      if (txidRowLooksAccepted(t)) accepted = true
      if (t.doubleSpend) doubleSpend = true
      // MissingInputs stays its own fact. Folding it into doubleSpend made an
      // incomplete BEEF indistinguishable from a spent input at every caller.
      if (txidRowLooksMissingInputs(t)) missingInputs = true
      if (t.serviceError) anyServiceError = true
      for (const c of t.competingTxs ?? []) {
        const id = normalizeTxid(c)
        if (id) competing.add(id)
      }
    }
    if (r.status === 'error' && !r.txidResults?.length) anyServiceError = true
  }

  if (!accepted && results.some((r) => r.status === 'success')) accepted = true

  return {
    accepted,
    doubleSpend,
    missingInputs,
    serviceOnlyErrors:
      !accepted && !doubleSpend && !missingInputs && (anyServiceError || !anyTxRow),
    detail: parts.join(', ') || 'no services',
    competingTxs: [...competing],
  }
}

/**
 * `ancestryIncomplete` means we knowingly posted a BEEF we could not complete.
 * MissingInputs is then a statement about our BEEF, not about the outpoint —
 * saying "Already spent" there accuses a tip the wallet can still spend. Callers
 * pass it only after chain proof showed no input was actually spent; a provider
 * `doubleSpend` flag alongside MissingInputs (Bitails) is not evidence either.
 */
export function formatPostBeefFailure(
  summary: PostBeefSummary,
  opts?: { ancestryIncomplete?: boolean },
): string {
  if (opts?.ancestryIncomplete && summary.missingInputs) {
    return 'Not broadcast — a parent transaction is not on chain yet'
  }
  if (summary.missingInputs || summary.doubleSpend) return 'Already spent'
  if (summary.serviceOnlyErrors) return 'No network'
  return 'Not sent'
}

export function isInvalidBeefTransport(msg: string): boolean {
  return /4022206465|4022206466|beef|mergeRawTx|invalid/i.test(msg)
}

export type DeliverSignedTxOutcome = 'accepted' | 'deferred' | 'conflict_real'

export type DeliverSignedTxResult = {
  outcome: DeliverSignedTxOutcome
  summary?: PostBeefSummary
  detail?: string
}

/**
 * Submit a locally signed tx to miners — delivery only, not validity.
 *
 * Bitcoin validity is established at sign time (inputs, scripts, fees). A miner
 * or ARC returning error / doubleSpend does not undo that; only on-chain proof
 * that inputs were spent elsewhere do we treat the local spend as dead.
 */
export async function deliverSignedTxBestEffort(args: {
  txid: string
  atomic: number[]
  chain: Chain
  logPrefix?: string
}): Promise<DeliverSignedTxResult> {
  const prefix = args.logPrefix ?? '[deliver]'
  const id = normalizeTxid(args.txid)
  if (!id) {
    return { outcome: 'conflict_real', detail: 'invalid txid' }
  }

  const postBeef = getActiveWallet()?.services?.postBeef
  if (!postBeef) {
    console.info(`${prefix} no postBeef — signed tx valid locally; monitor may broadcast`)
    return { outcome: 'deferred', detail: 'no_service' }
  }

  const { Beef } = await import('@bsv/sdk')
  let summary: PostBeefSummary
  try {
    const results = await postBeef(Beef.fromBinary(args.atomic), [id])
    summary = summarizePostBeef(results as never)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`${prefix} postBeef transport failed`, id.slice(0, 12), msg)
    if (isInvalidBeefTransport(msg)) {
      return { outcome: 'conflict_real', detail: msg }
    }
    return { outcome: 'deferred', detail: msg }
  }

  if (summary.accepted) {
    return { outcome: 'accepted', summary }
  }

  if (summary.doubleSpend || summary.missingInputs) {
    const conflictReal = await postBeefConflictIsReal({
      txid: id,
      atomic: args.atomic,
      chain: args.chain,
    })
    if (conflictReal) {
      return { outcome: 'conflict_real', summary }
    }
    console.info(
      `${prefix} ghost doubleSpend — keeping local spend of ${id.slice(0, 12)}…`,
    )
    return { outcome: 'deferred', summary, detail: 'ghost_conflict' }
  }

  console.info(`${prefix} delivery deferred`, summary.detail)
  return { outcome: 'deferred', summary, detail: summary.detail }
}

/**
 * Arcade V2 often reports `doubleSpend` when the tx never reached any node.
 * Only treat the conflict as real when the tx or its inputs are gone on-chain.
 */
export async function postBeefConflictIsReal(args: {
  txid: string
  atomic?: number[]
  chain: Chain
}): Promise<boolean> {
  const txid = normalizeTxid(args.txid)
  if (!txid) return true

  const onChain = await txExistsOnChain(txid, args.chain).catch(() => null)
  if (onChain === true) return true
  // Unknown explorer answer must NOT count as a proven conflict — that used to
  // call onAlreadySpentSend and hide live change forever (failed consolidate).
  // Fall through and inspect inputs; inconclusive → not proven.

  const inputs = await inputOutpointsForSignedTx(txid, args.atomic)
  if (inputs.length === 0) return false

  const statuses = await Promise.all(
    inputs.map((op) => spentStatusOfOutpoint(op, args.chain).catch(() => 'unknown' as const)),
  )
  // Any unknown answer → not proven. Prefer a ghost/retry over hiding spendable change.
  if (statuses.some((s) => s === 'unknown')) return false
  return statuses.some((s) => s === 'spent')
}
