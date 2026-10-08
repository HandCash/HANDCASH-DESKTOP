/**
 * Durable archive of every locally signed transaction template.
 *
 * The miner outbox may drop a body after Arcade accepts it. Heal must still
 * be able to reseal inputs and keep change from the exact signed Atomic BEEF,
 * so this store is the cheque itself — not Activity hashes or explorer lookups.
 *
 * One durable key per cheque plus a small index. v1 kept every body in one
 * JSON value capped at 1MB: a nine-item import sweep whose Atomic BEEF carried
 * full inscription parents (~850KB, ~1.1MB as base64) could never fit, so its
 * archive was refused and the outbox fell back to an inline number array
 * (3MB key). Each send also re-serialized the whole archive.
 */
import { Beef, Utils } from '@bsv/sdk'
import {
  accountLocalKey,
  accountLocalKeyFor,
  type BoundAccountKeyScope,
} from './accountLocalKeys'
import {
  durableGetItem,
  durableRemoveItem,
  durableSetItem,
  durableStoreIsShell,
} from './durableStorage'
import { storageRegistry } from '../storage/registry'
import type { TransactionFlow } from './transactionTelemetry'

const INDEX_BASE = storageRegistry.signedChequeIndex.key
const BODY_PREFIX = storageRegistry.signedChequeBodyPrefix.key
const LEGACY_ARCHIVE_BASE = storageRegistry.signedChequeArchive.key
const CREATED_BEEF_INDEX = storageRegistry.createdBeefIndex.key
const CREATED_BEEF_PREFIX = storageRegistry.createdBeefPrefix.key
const PENDING_MINER_KEY = storageRegistry.pendingMinerOutbox.key
const MAX_ROWS = 500
/** Same ceiling the miner outbox accepts for one signed body. */
const MAX_BODY_BYTES = 2 * 1024 * 1024
/**
 * Soft budget for all bodies together. Where origin storage is the store (a
 * Mobile build without its app file store) the whole origin quota is a few
 * megabytes shared with Activity, chat and item art, so the archive keeps to
 * 1MB there. A cheque is only needed until its transaction is proven; the
 * oldest go first, and a cheque the outbox still references never goes.
 */
const SHELL_BUDGET_CHARS = 8 * 1024 * 1024
const ORIGIN_BUDGET_CHARS = 1024 * 1024

export type SignedCheque = {
  txid: string
  atomic: number[]
  createdAt: number
  flow?: TransactionFlow
}

type IndexRow = {
  txid: string
  createdAt: number
  flow?: TransactionFlow
  /** Stored base64 length. */
  chars: number
}

function scopedKey(base: string, owner?: BoundAccountKeyScope): string {
  return owner ? accountLocalKeyFor(base, owner) : accountLocalKey(base)
}

function bodyKey(txid: string, owner?: BoundAccountKeyScope): string {
  return scopedKey(BODY_PREFIX + txid, owner)
}

function bodyIsSignedCheque(txid: string, atomic: number[]): boolean {
  const id = txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(id) || atomic.length === 0) return false
  try {
    const found = Beef.fromBinary(atomic).findTxid(id)
    return !!found?.tx && found.isTxidOnly !== true
  } catch {
    return false
  }
}

function decodeAtomic(b64: string): number[] | null {
  try {
    const bytes = Utils.toArray(b64, 'base64')
    return Array.isArray(bytes) && bytes.length > 0 ? [...bytes] : null
  } catch {
    return null
  }
}

function budgetChars(): number {
  return durableStoreIsShell() ? SHELL_BUDGET_CHARS : ORIGIN_BUDGET_CHARS
}

function outboxTxids(owner?: BoundAccountKeyScope): Set<string> {
  const txids = new Set<string>()
  try {
    const pending = JSON.parse(
      durableGetItem(scopedKey(PENDING_MINER_KEY, owner)) || '[]',
    ) as unknown
    if (Array.isArray(pending)) {
      for (const row of pending) {
        const txid = String((row as { txid?: unknown })?.txid ?? '')
          .trim()
          .toLowerCase()
        if (/^[0-9a-f]{64}$/.test(txid)) txids.add(txid)
      }
    }
  } catch {
    /* a malformed old queue must not block archiving the new cheque */
  }
  return txids
}

/**
 * Verified body per durable key, keyed by the exact stored string.
 * `signedChequeAtomic` is consulted on every local BEEF lookup; decoding
 * base64 and parsing the BEEF once per stored value, not per call.
 */
const verifiedByKey = new Map<string, { raw: string; body: number[] | null }>()

function readBody(txid: string, owner?: BoundAccountKeyScope): number[] | null {
  const key = bodyKey(txid, owner)
  const raw = durableGetItem(key)
  if (!raw) return null
  const cached = verifiedByKey.get(key)
  if (cached?.raw === raw) return cached.body
  const atomic = decodeAtomic(raw)
  const body = atomic && bodyIsSignedCheque(txid, atomic) ? atomic : null
  verifiedByKey.set(key, { raw, body })
  return body
}

/** Last parse per account index key, keyed by the exact stored string. */
const parsedByKey = new Map<string, { raw: string; rows: IndexRow[] }>()

function parseIndex(raw: string): IndexRow[] {
  const parsed = JSON.parse(raw) as unknown
  if (!Array.isArray(parsed)) return []
  return parsed.filter(
    (row): row is IndexRow =>
      !!row &&
      typeof row === 'object' &&
      typeof (row as IndexRow).txid === 'string' &&
      typeof (row as IndexRow).chars === 'number',
  )
}

function loadIndex(owner?: BoundAccountKeyScope): IndexRow[] {
  try {
    const key = scopedKey(INDEX_BASE, owner)
    const raw = durableGetItem(key)
    if (raw == null) return migrateToIndex(owner)
    const cached = parsedByKey.get(key)
    if (cached?.raw === raw) return cached.rows
    const rows = parseIndex(raw)
    parsedByKey.set(key, { raw, rows })
    return rows
  } catch {
    return []
  }
}

function writeIndex(rows: IndexRow[], owner?: BoundAccountKeyScope): boolean {
  return durableSetItem(scopedKey(INDEX_BASE, owner), JSON.stringify(rows))
}

/**
 * First read on this build: move the v1 single-value archive into per-cheque
 * keys, along with any body the outbox still holds inline because v1 refused
 * it, and the old 16-slot createdBeef backup.
 */
function migrateToIndex(owner?: BoundAccountKeyScope): IndexRow[] {
  const rows: IndexRow[] = []
  const seen = new Set<string>()
  const take = (
    txid: string,
    atomic: number[] | null,
    createdAt?: unknown,
    flow?: unknown,
  ) => {
    const id = txid.trim().toLowerCase()
    if (!atomic || seen.has(id) || !bodyIsSignedCheque(id, atomic)) return
    if (atomic.length > MAX_BODY_BYTES) return
    const b64 = Utils.toBase64(atomic)
    if (!durableSetItem(bodyKey(id, owner), b64)) return
    seen.add(id)
    rows.push({
      txid: id,
      createdAt:
        typeof createdAt === 'number' && Number.isFinite(createdAt)
          ? createdAt
          : Date.now(),
      ...(typeof flow === 'string' ? { flow: flow as TransactionFlow } : {}),
      chars: b64.length,
    })
  }
  const legacyKey = scopedKey(LEGACY_ARCHIVE_BASE, owner)
  try {
    const legacy = JSON.parse(durableGetItem(legacyKey) || '[]') as unknown
    if (Array.isArray(legacy)) {
      for (const row of legacy) {
        const rec = row as { txid?: unknown; atomicB64?: unknown; createdAt?: unknown; flow?: unknown }
        if (typeof rec?.atomicB64 !== 'string') continue
        take(String(rec.txid ?? ''), decodeAtomic(rec.atomicB64), rec.createdAt, rec.flow)
      }
    }
  } catch {
    /* an unreadable v1 archive leaves the other sources */
  }
  try {
    const pending = JSON.parse(
      durableGetItem(scopedKey(PENDING_MINER_KEY, owner)) || '[]',
    ) as unknown
    if (Array.isArray(pending)) {
      for (const row of pending) {
        const rec = row as { txid?: unknown; atomic?: unknown; createdAt?: unknown; flow?: unknown }
        if (!Array.isArray(rec?.atomic)) continue
        take(String(rec.txid ?? ''), rec.atomic as number[], rec.createdAt, rec.flow)
      }
    }
  } catch {
    /* miner outbox is a source, not a requirement */
  }
  try {
    const index = JSON.parse(durableGetItem(CREATED_BEEF_INDEX) || '[]') as unknown
    if (Array.isArray(index)) {
      for (const txid of index) {
        const b64 = durableGetItem(CREATED_BEEF_PREFIX + String(txid))
        if (b64) take(String(txid), decodeAtomic(b64))
      }
    }
  } catch {
    /* 16-slot createdBeef was the previous leaky backup */
  }
  rows.sort((a, b) => a.createdAt - b.createdAt)
  // Without an index the bodies are unreachable, so v1 stays until one lands.
  if (!writeIndex(rows, owner)) return rows
  if (durableGetItem(legacyKey) != null) durableRemoveItem(legacyKey)
  if (rows.length > 0) {
    console.info(`[signed-cheque] archive moved to per-cheque keys — ${rows.length} cheque(s)`)
  }
  return rows
}

/**
 * Oldest first. Never drops `keep` or a cheque the outbox references; over a
 * full budget with nothing evictable the archive grows rather than refuse —
 * a refused archive fails the send closed.
 */
function evictToBudget(
  rows: IndexRow[],
  keep: string,
  owner?: BoundAccountKeyScope,
): { kept: IndexRow[]; evicted: IndexRow[] } {
  const budget = budgetChars()
  let total = rows.reduce((sum, row) => sum + row.chars, 0)
  if (rows.length <= MAX_ROWS && total <= budget) return { kept: rows, evicted: [] }
  const protectedTxids = outboxTxids(owner)
  protectedTxids.add(keep)
  const ordered = [...rows].sort((a, b) => a.createdAt - b.createdAt)
  const drop = new Set<string>()
  let count = rows.length
  for (const row of ordered) {
    if (count <= MAX_ROWS && total <= budget) break
    if (protectedTxids.has(row.txid)) continue
    drop.add(row.txid)
    count -= 1
    total -= row.chars
  }
  return {
    kept: rows.filter((row) => !drop.has(row.txid)),
    evicted: rows.filter((row) => drop.has(row.txid)),
  }
}

export function archiveSignedCheque(
  txid: string,
  atomic: number[],
  opts?: {
    flow?: TransactionFlow
    owner?: BoundAccountKeyScope
    /** Caller proved this body supersedes the queued version (e.g. ancestry merge). */
    replace?: boolean
  },
): boolean {
  if (!bodyIsSignedCheque(txid, atomic)) return false
  const id = txid.trim().toLowerCase()
  const owner = opts?.owner
  if (atomic.length > MAX_BODY_BYTES) {
    console.error(
      `[signed-cheque] durable write refused ${id.slice(0, 12)} — body ${Math.round(atomic.length / 1024)}KB over ${MAX_BODY_BYTES / 1024 / 1024}MB`,
    )
    return false
  }
  const b64 = Utils.toBase64(atomic)
  const rows = loadIndex(owner).map((row) => ({ ...row }))
  const existing = rows.find((row) => row.txid === id)
  if (existing && !opts?.replace && b64.length < existing.chars && readBody(id, owner)) {
    return true
  }
  const key = bodyKey(id, owner)
  const previousBody = existing ? durableGetItem(key) : null
  if (!durableSetItem(key, b64)) {
    console.error(
      `[signed-cheque] durable write refused ${id.slice(0, 12)} — store rejected ${Math.round(b64.length / 1024)}KB`,
    )
    return false
  }
  if (existing) {
    existing.chars = b64.length
    existing.flow = opts?.flow ?? existing.flow
  } else {
    rows.push({
      txid: id,
      createdAt: Date.now(),
      ...(opts?.flow ? { flow: opts.flow } : {}),
      chars: b64.length,
    })
  }
  const { kept, evicted } = evictToBudget(rows, id, owner)
  if (!writeIndex(kept, owner)) {
    // An index that never names the body leaves it unreachable; put back what was there.
    if (previousBody != null) durableSetItem(key, previousBody)
    else durableRemoveItem(key)
    console.error(`[signed-cheque] durable write refused ${id.slice(0, 12)} — index write rejected`)
    return false
  }
  for (const row of evicted) durableRemoveItem(bodyKey(row.txid, owner))
  if (evicted.length > 0) {
    console.warn(
      `[signed-cheque] evicted ${evicted.length} archived cheque(s) to fit durable storage`,
    )
  }
  return true
}

export function signedChequeAtomic(
  txid: string,
  owner?: BoundAccountKeyScope,
): number[] | null {
  const id = txid.trim().toLowerCase()
  if (!loadIndex(owner).some((row) => row.txid === id)) return null
  const body = readBody(id, owner)
  return body ? [...body] : null
}

/** Index only: each first body read is a synchronous shell round trip. */
export function listSignedChequeTxids(owner?: BoundAccountKeyScope): string[] {
  return loadIndex(owner).map((row) => row.txid)
}

export function listSignedCheques(owner?: BoundAccountKeyScope): SignedCheque[] {
  const cheques: SignedCheque[] = []
  for (const row of loadIndex(owner)) {
    const body = readBody(row.txid, owner)
    if (!body) continue
    cheques.push({
      txid: row.txid,
      atomic: [...body],
      createdAt: row.createdAt,
      flow: row.flow,
    })
  }
  return cheques
}
