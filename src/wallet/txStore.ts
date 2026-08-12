/**
 * Durable dual-layer transaction store (optimistic + canonical projection).
 * ACID-ish via single-key rewrite; all mutations go through transition helpers.
 */
import { durableGetItem, durableSetItem } from './durableStorage'
import {
  canTransitionTx,
  diagnosticFromArc,
  normalizeOutpointKey,
  type ArcStatus,
  type TxDiagnosticCode,
  type TxRecord,
  type TxStatus,
  txStatusFromArc,
} from './txLifecycle'

const KEY = 'handcash.wallet.txLifecycle.v1'
const MAX_ENTRIES = 500

type Listener = (records: TxRecord[]) => void

const listeners = new Set<Listener>()
let cache: Map<string, TxRecord> | null = null

function load(): Map<string, TxRecord> {
  if (cache) return cache
  cache = new Map()
  try {
    const raw = durableGetItem(KEY)
    if (!raw) return cache
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return cache
    for (const row of parsed) {
      const rec = coerceRecord(row)
      if (rec) cache.set(rec.id, rec)
    }
  } catch {
    // ignore corrupt store
  }
  return cache
}

function coerceRecord(row: unknown): TxRecord | null {
  if (!row || typeof row !== 'object') return null
  const r = row as Record<string, unknown>
  if (typeof r.id !== 'string' || !r.id) return null
  const status = r.status as TxStatus
  const allowed: TxStatus[] = [
    'DRAFT',
    'VALIDATING',
    'BROADCASTING',
    'SEEN_IN_MEMPOOL',
    'MINED',
    'FAILED_REJECTED',
    'REORG_ORPHANED',
  ]
  if (!allowed.includes(status)) return null
  const inputs = Array.isArray(r.inputOutpoints)
    ? r.inputOutpoints
        .filter((x): x is string => typeof x === 'string')
        .map(normalizeOutpointKey)
    : []
  return {
    id: r.id,
    status,
    txid: typeof r.txid === 'string' ? r.txid.toLowerCase() : null,
    satoshis: Math.max(0, Math.trunc(Number(r.satoshis) || 0)),
    to: typeof r.to === 'string' ? r.to : null,
    inputOutpoints: inputs,
    arcStatus: (r.arcStatus as ArcStatus | null) ?? null,
    diagnostic: (r.diagnostic as TxDiagnosticCode | null) ?? null,
    diagnosticDetail: typeof r.diagnosticDetail === 'string' ? r.diagnosticDetail : null,
    minedHeight:
      typeof r.minedHeight === 'number' && Number.isFinite(r.minedHeight)
        ? Math.trunc(r.minedHeight)
        : null,
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : Date.now(),
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : Date.now(),
  }
}

function persist(): void {
  const map = load()
  const rows = [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  while (rows.length > MAX_ENTRIES) {
    const drop = rows.pop()
    if (drop) map.delete(drop.id)
  }
  durableSetItem(KEY, JSON.stringify(rows))
  for (const listener of listeners) listener(rows)
}

function newId(): string {
  return `tx-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}`
}

export function listTxRecords(): TxRecord[] {
  return [...load().values()].sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getTxRecord(id: string): TxRecord | null {
  return load().get(id) ?? null
}

export function getTxByTxid(txid: string): TxRecord | null {
  const needle = txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(needle)) return null
  for (const rec of load().values()) {
    if (rec.txid === needle) return rec
  }
  return null
}

export function subscribeTxStore(listener: Listener): () => void {
  listeners.add(listener)
  listener(listTxRecords())
  return () => {
    listeners.delete(listener)
  }
}

export function createDraftTx(args: {
  satoshis: number
  to?: string | null
  inputOutpoints?: string[]
  id?: string
}): TxRecord {
  const now = Date.now()
  const rec: TxRecord = {
    id: args.id ?? newId(),
    status: 'DRAFT',
    txid: null,
    satoshis: Math.max(0, Math.trunc(args.satoshis)),
    to: args.to?.trim() || null,
    inputOutpoints: (args.inputOutpoints ?? []).map(normalizeOutpointKey),
    arcStatus: null,
    diagnostic: null,
    diagnosticDetail: null,
    minedHeight: null,
    createdAt: now,
    updatedAt: now,
  }
  load().set(rec.id, rec)
  persist()
  return rec
}

export function transitionTx(
  id: string,
  to: TxStatus,
  patch?: Partial<
    Pick<
      TxRecord,
      | 'txid'
      | 'arcStatus'
      | 'diagnostic'
      | 'diagnosticDetail'
      | 'minedHeight'
      | 'inputOutpoints'
      | 'satoshis'
      | 'to'
    >
  >,
): TxRecord | null {
  const map = load()
  const cur = map.get(id)
  if (!cur) return null
  if (!canTransitionTx(cur.status, to)) {
    console.warn('[tx-store] illegal transition', cur.status, '→', to, id)
    return null
  }
  const next: TxRecord = {
    ...cur,
    ...patch,
    status: to,
    txid: patch?.txid !== undefined ? patch.txid?.toLowerCase() ?? null : cur.txid,
    inputOutpoints: patch?.inputOutpoints
      ? patch.inputOutpoints.map(normalizeOutpointKey)
      : cur.inputOutpoints,
    updatedAt: Date.now(),
  }
  map.set(id, next)
  persist()
  return next
}

/** Apply ARC callback / poll — does not advance to MINED (needs SPV gate). */
export function applyArcStatus(id: string, arc: ArcStatus): TxRecord | null {
  const cur = getTxRecord(id)
  if (!cur) return null
  const mapped = txStatusFromArc(arc)
  const diag = diagnosticFromArc(arc)
  if (mapped === 'FAILED_REJECTED') {
    return transitionTx(id, 'FAILED_REJECTED', {
      arcStatus: arc,
      diagnostic: diag,
      diagnosticDetail: diag,
    })
  }
  // ARC MINED → stay SEEN_IN_MEMPOOL until BUMP verifies.
  const target: TxStatus =
    cur.status === 'DRAFT' || cur.status === 'VALIDATING'
      ? mapped === 'SEEN_IN_MEMPOOL'
        ? 'BROADCASTING'
        : mapped
      : mapped === 'BROADCASTING' && cur.status === 'SEEN_IN_MEMPOOL'
        ? 'SEEN_IN_MEMPOOL'
        : mapped
  if (!canTransitionTx(cur.status, target) && cur.status !== target) {
    // Allow BROADCASTING → SEEN_IN_MEMPOOL; upgrade in place when already there.
    if (cur.status === 'SEEN_IN_MEMPOOL' && target === 'SEEN_IN_MEMPOOL') {
      return transitionTx(id, 'SEEN_IN_MEMPOOL', { arcStatus: arc })
    }
    return null
  }
  return transitionTx(id, target, {
    arcStatus: arc,
    diagnostic: null,
    diagnosticDetail: null,
  })
}

/** Commit hard finality after SPV-verified BUMP. */
export function markTxMined(id: string, height: number): TxRecord | null {
  return transitionTx(id, 'MINED', {
    minedHeight: Math.trunc(height),
    arcStatus: 'MINED',
    diagnostic: null,
    diagnosticDetail: null,
  })
}

export function markTxFailed(
  id: string,
  code: TxDiagnosticCode,
  detail?: string | null,
): TxRecord | null {
  return transitionTx(id, 'FAILED_REJECTED', {
    diagnostic: code,
    diagnosticDetail: detail ?? code,
  })
}

export function markTxReorgOrphaned(id: string): TxRecord | null {
  return transitionTx(id, 'REORG_ORPHANED', {
    minedHeight: null,
    diagnostic: 'REORG',
    diagnosticDetail: 'Block reorg orphaned this transaction',
  })
}

/** Pending confirmation set for reconcile workers. */
export function listPendingConfirmation(): TxRecord[] {
  return listTxRecords().filter(
    (r) =>
      r.status === 'BROADCASTING' ||
      r.status === 'SEEN_IN_MEMPOOL' ||
      r.status === 'REORG_ORPHANED',
  )
}

/** Test helper — wipe in-memory + durable store. */
export function __resetTxStoreForTests(): void {
  cache = new Map()
  durableSetItem(KEY, '[]')
}
