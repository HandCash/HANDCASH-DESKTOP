/**
 * Interpret toolbox `postBeef` / `postRaws` results.
 *
 * Top-level `status: 'error'` is not enough — Bitails marks missing-inputs as
 * error+doubleSpend, while already-in-mempool stays success on the txid row.
 */
import { inputOutpointsFromAtomicBeef, inputOutpointsFromRawTx } from './txOutpoints'
import { spentStatusOfOutpoint, txExistsOnChain } from './legacyScan'
import type { Chain } from './vault'
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

function noteWhat(notes: Array<{ what?: string }> | undefined): string[] {
  return (notes ?? []).map((n) => String(n.what ?? '')).filter(Boolean)
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
    parts.push(`${name}:${r.status || 'unknown'}`)
    for (const t of r.txidResults ?? []) {
      anyTxRow = true
      const notes = noteWhat(t.notes)
      if (t.status === 'success' || t.alreadyKnown) accepted = true
      if (notes.some((w) => /AlreadyInMempool/i.test(w))) accepted = true
      if (t.doubleSpend) doubleSpend = true
      if (notes.some((w) => /MissingInputs/i.test(w))) {
        missingInputs = true
        doubleSpend = true
      }
      if (t.serviceError) anyServiceError = true
      for (const c of t.competingTxs ?? []) {
        const id = c.trim().toLowerCase()
        if (/^[0-9a-f]{64}$/.test(id)) competing.add(id)
      }
      if (t.status === 'error' && t.data && typeof t.data === 'object') {
        const msg = String((t.data as { message?: string }).message ?? '')
        if (/missing.?input/i.test(msg)) {
          missingInputs = true
          doubleSpend = true
        }
      }
    }
    if (r.status === 'error' && !r.txidResults?.length) anyServiceError = true
  }

  if (!accepted && results.some((r) => r.status === 'success')) accepted = true

  return {
    accepted,
    doubleSpend,
    missingInputs,
    serviceOnlyErrors: !accepted && !doubleSpend && (anyServiceError || !anyTxRow),
    detail: parts.join(', ') || 'no services',
    competingTxs: [...competing],
  }
}

export function formatPostBeefFailure(summary: PostBeefSummary): string {
  if (summary.missingInputs || summary.doubleSpend) return 'Already spent'
  if (summary.serviceOnlyErrors) return 'No network'
  return 'Not sent'
}

export type DeliverSignedTxOutcome = 'accepted' | 'deferred' | 'conflict_real'

export type DeliverSignedTxResult = {
  outcome: DeliverSignedTxOutcome
  summary?: PostBeefSummary
  detail?: string
}

function invalidSignedBodyError(message: string): boolean {
  return /4022206465|4022206466|beef|mergeRawTx|invalid/i.test(message)
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
  const id = args.txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(id)) {
    return { outcome: 'conflict_real', detail: 'invalid txid' }
  }

  const { getActiveWallet } = await import('./session')
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
    if (invalidSignedBodyError(msg)) {
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
  const txid = args.txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(txid)) return true

  const onChain = await txExistsOnChain(txid, args.chain).catch(() => null)
  if (onChain === true) return true
  if (onChain === null) return true

  let inputs: string[] = []
  if (args.atomic?.length) {
    inputs = inputOutpointsFromAtomicBeef(args.atomic, txid)
  }
  if (inputs.length === 0) {
    const { getActiveWallet } = await import('./session')
    const storage = getActiveWallet()?.wallet?.storage
    if (storage?.runAsStorageProvider) {
      try {
        const raw = await storage.runAsStorageProvider(
          async (sp: { getProvenOrRawTx?: (id: string) => Promise<{ rawTx?: number[] }> }) =>
            sp.getProvenOrRawTx?.(txid),
        )
        if (raw?.rawTx?.length) inputs = inputOutpointsFromRawTx(raw.rawTx)
      } catch {
        /* local raw optional */
      }
    }
  }
  if (inputs.length === 0) return false

  const statuses = await Promise.all(
    inputs.map((op) => spentStatusOfOutpoint(op, args.chain).catch(() => 'unknown' as const)),
  )
  if (statuses.some((s) => s === 'unknown')) return true
  return statuses.some((s) => s === 'spent')
}
