/**
 * Durable archive of every locally signed transaction template.
 *
 * The miner outbox may drop a body after Arcade accepts it. Heal must still
 * be able to reseal inputs and keep change from the exact signed Atomic BEEF,
 * so this store is the cheque itself — not Activity hashes or explorer lookups.
 */
import { Beef, Utils } from '@bsv/sdk'
import {
  accountLocalKey,
  accountLocalKeyFor,
  type BoundAccountKeyScope,
} from './accountLocalKeys'
import { durableGetItem, durableSetItem } from './durableStorage'
import { storageRegistry } from '../storage/registry'
import type { TransactionFlow } from './transactionTelemetry'

const KEY_BASE = storageRegistry.signedChequeArchive.key
const CREATED_BEEF_INDEX = storageRegistry.createdBeefIndex.key
const CREATED_BEEF_PREFIX = storageRegistry.createdBeefPrefix.key
const PENDING_MINER_KEY = storageRegistry.pendingMinerOutbox.key
const MAX_ROWS = 500
/**
 * Byte ceiling for the serialized archive.
 *
 * On the mobile shell, origin storage *is* the durable store, and its
 * whole-origin quota is a few megabytes shared with Activity, chat and item
 * art. An unbounded row count of full Atomic BEEFs filled it, every write
 * threw `QuotaExceededError`, and — because a refused archive fails the send
 * closed — the wallet stopped signing anything at all. A cheque is only needed
 * until its transaction is proven, so budget the store and evict the oldest.
 */
const MAX_BYTES = 1024 * 1024

export type SignedCheque = {
  txid: string
  atomic: number[]
  createdAt: number
  flow?: TransactionFlow
}

type StoredCheque = {
  txid: string
  atomicB64: string
  createdAt: number
  flow?: TransactionFlow
}

function scopedKey(base: string, owner?: BoundAccountKeyScope): string {
  return owner ? accountLocalKeyFor(base, owner) : accountLocalKey(base)
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

function toCheque(row: StoredCheque): SignedCheque | null {
  const txid = String(row.txid ?? '').trim().toLowerCase()
  const atomic = decodeAtomic(String(row.atomicB64 ?? ''))
  if (!atomic || !bodyIsSignedCheque(txid, atomic)) {
    return null
  }
  return {
    txid,
    atomic,
    createdAt:
      typeof row.createdAt === 'number' && Number.isFinite(row.createdAt)
        ? row.createdAt
        : Date.now(),
    flow: row.flow,
  }
}

function migrateLegacyBodies(owner?: BoundAccountKeyScope): StoredCheque[] {
  const extra: StoredCheque[] = []
  const seen = new Set<string>()
  const take = (txid: string, atomic: number[], flow?: TransactionFlow) => {
    const id = txid.trim().toLowerCase()
    if (seen.has(id) || !bodyIsSignedCheque(id, atomic)) {
      return
    }
    seen.add(id)
    extra.push({
      txid: id,
      atomicB64: Utils.toBase64(atomic),
      createdAt: Date.now(),
      flow,
    })
  }
  try {
    const pending = JSON.parse(
      durableGetItem(scopedKey(PENDING_MINER_KEY, owner)) || '[]',
    ) as unknown
    if (Array.isArray(pending)) {
      for (const row of pending) {
        const rec = row as { txid?: unknown; atomic?: unknown; flow?: unknown }
        if (!Array.isArray(rec.atomic)) continue
        take(
          String(rec.txid ?? ''),
          rec.atomic as number[],
          typeof rec.flow === 'string' ? (rec.flow as TransactionFlow) : undefined,
        )
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
        if (!b64) continue
        const atomic = decodeAtomic(b64)
        if (atomic) take(String(txid), atomic)
      }
    }
  } catch {
    /* 16-slot createdBeef was the previous leaky backup */
  }
  return extra
}

function loadStored(owner?: BoundAccountKeyScope): StoredCheque[] {
  try {
    const parsed = JSON.parse(
      durableGetItem(scopedKey(KEY_BASE, owner)) || '[]',
    ) as unknown
    if (!Array.isArray(parsed) || parsed.length === 0) {
      const migrated = migrateLegacyBodies(owner)
      if (migrated.length > 0) saveStored(migrated, owner)
      return migrated
    }
    return parsed.filter(
      (row): row is StoredCheque =>
        !!row &&
        typeof row === 'object' &&
        typeof (row as StoredCheque).txid === 'string' &&
        typeof (row as StoredCheque).atomicB64 === 'string',
    )
  } catch {
    return []
  }
}

function saveStored(
  rows: StoredCheque[],
  owner?: BoundAccountKeyScope,
): boolean {
  const key = scopedKey(KEY_BASE, owner)
  // Oldest first. Callers append, so the cheque being archived is last and is
  // the one row never dropped to make the write fit.
  let kept = rows.slice(-MAX_ROWS)
  for (;;) {
    const body = JSON.stringify(kept)
    if (body.length <= MAX_BYTES && durableSetItem(key, body)) {
      const evicted = rows.length - kept.length
      if (evicted > 0) {
        console.warn(
          `[signed-cheque] evicted ${evicted} archived cheque(s) to fit durable storage`,
        )
      }
      return true
    }
    if (kept.length <= 1) return false
    kept = kept.slice(1)
  }
}

export function archiveSignedCheque(
  txid: string,
  atomic: number[],
  opts?: { flow?: TransactionFlow; owner?: BoundAccountKeyScope },
): boolean {
  if (!bodyIsSignedCheque(txid, atomic)) return false
  const id = txid.trim().toLowerCase()
  const rows = loadStored(opts?.owner)
  const next: StoredCheque = {
    txid: id,
    atomicB64: Utils.toBase64(atomic),
    createdAt: Date.now(),
    flow: opts?.flow,
  }
  const existing = rows.find((row) => row.txid === id)
  if (existing) {
    const prev = decodeAtomic(existing.atomicB64) ?? []
    if (atomic.length < prev.length) return true
    existing.atomicB64 = next.atomicB64
    existing.flow = opts?.flow ?? existing.flow
    return saveStored(rows, opts?.owner)
  }
  rows.push(next)
  if (!saveStored(rows, opts?.owner)) {
    console.error('[signed-cheque] durable write refused', id.slice(0, 12))
    return false
  }
  return true
}

export function signedChequeAtomic(txid: string): number[] | null {
  const id = txid.trim().toLowerCase()
  const row = loadStored().find((item) => item.txid === id)
  if (!row) return null
  return toCheque(row)?.atomic ?? null
}

export function listSignedChequeTxids(): string[] {
  return loadStored()
    .map((row) => toCheque(row)?.txid)
    .filter((txid): txid is string => !!txid)
}

export function listSignedCheques(): SignedCheque[] {
  return loadStored()
    .map(toCheque)
    .filter((row): row is SignedCheque => row != null)
}
