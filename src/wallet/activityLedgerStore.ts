/**
 * The last Activity ledger read, on disk, one record per account namespace.
 *
 * A cold read copies every transaction record whole, and on a phone with a
 * long import history that took minutes behind the storage lock — every launch
 * painted Activity without its imports until it finished. This copy paints
 * first and the live read replaces it. Display only: never consulted for
 * balance, spends or custody.
 *
 * The record also keeps the few ledger fields of every settled transaction
 * the read has seen. Those never change, and IndexedDB clones a transaction
 * record whole — an import leg carries a megabyte of parent BEEF — so a
 * launch reads only transactions it has not seen yet.
 */
import { storageRegistry } from '../storage/registry'
import type { LedgerTx } from './activityLedger'
import type { ActivityEntry } from './appActivity'

/** The `handcash-brc100` prefix is what a wallet wipe deletes. */
export const ACTIVITY_LEDGER_DB = storageRegistry.activityLedger.key
const DB_VERSION = 1
const STORE = 'snapshots'
/** Newest rows kept; older history still shows once the live read lands. */
const MAX_ROWS = 10_000

/** Ledger fields of the settled transactions one wallet user's read has seen. */
export type SavedLedgerTxs = { userId: number; txs: LedgerTx[] }

export type SavedLedger = { rows: ActivityEntry[] | null; txs: SavedLedgerTxs | null }

type SnapshotRecord = { namespace: string; savedAt: number; rows: ActivityEntry[]; txs?: SavedLedgerTxs }

let opening: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  if (opening) return opening
  opening = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('This device has no IndexedDB'))
      return
    }
    const req = indexedDB.open(ACTIVITY_LEDGER_DB, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'namespace' })
    }
    req.onsuccess = () => {
      const db = req.result
      db.onversionchange = () => {
        db.close()
        opening = null
      }
      db.onclose = () => {
        opening = null
      }
      resolve(db)
    }
    req.onerror = () => reject(req.error ?? new Error('Could not open the saved Activity history'))
  })
  opening.catch(() => {
    opening = null
  })
  return opening
}

function isRow(value: unknown): value is ActivityEntry {
  if (!value || typeof value !== 'object') return false
  const row = value as Partial<ActivityEntry>
  return (
    typeof row.id === 'string' &&
    row.id.startsWith('ledger:') &&
    typeof row.txid === 'string' &&
    /^[0-9a-f]{64}$/.test(row.txid) &&
    typeof row.at === 'number' &&
    Number.isFinite(row.at) &&
    typeof row.sats === 'number' &&
    (row.kind === 'earned' || row.kind === 'spent')
  )
}

function isTx(value: unknown): value is LedgerTx {
  if (!value || typeof value !== 'object') return false
  const tx = value as LedgerTx
  return Number.isSafeInteger(tx.transactionId) && tx.transactionId! > 0
}

function savedTxsOf(value: unknown): SavedLedgerTxs | null {
  if (!value || typeof value !== 'object') return null
  const saved = value as Partial<SavedLedgerTxs>
  if (!Number.isSafeInteger(saved.userId) || saved.userId! <= 0 || !Array.isArray(saved.txs)) return null
  return { userId: saved.userId!, txs: saved.txs.filter(isTx) }
}

/** The rows the last live read published for this namespace (oldest first), and the transactions it had read. */
export async function loadLedgerSnapshot(namespace: string): Promise<SavedLedger> {
  const db = await open()
  const record = await new Promise<SnapshotRecord | undefined>((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(namespace)
    req.onsuccess = () => resolve(req.result as SnapshotRecord | undefined)
    req.onerror = () => reject(req.error ?? new Error('Saved Activity history read failed'))
  })
  if (!record) return { rows: null, txs: null }
  const rows = Array.isArray(record.rows) ? record.rows.filter(isRow).sort((a, b) => a.at - b.at) : []
  return { rows: rows.length > 0 ? rows : null, txs: savedTxsOf(record.txs) }
}

/**
 * `txs` replaces the saved transactions; `null` clears them (the store was
 * rewritten). Left out, the saved ones are kept: a write of rows alone must
 * not cost the next launch a reread of every transaction.
 */
export async function saveLedgerRows(
  namespace: string,
  rows: readonly ActivityEntry[],
  txs?: SavedLedgerTxs | null,
): Promise<void> {
  const db = await open()
  const kept = rows.length > MAX_ROWS ? rows.slice(rows.length - MAX_ROWS) : rows
  const record: SnapshotRecord = { namespace, savedAt: Date.now(), rows: [...kept] }
  if (txs) record.txs = { userId: txs.userId, txs: [...txs.txs] }
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    if (txs === undefined) {
      const prior = store.get(namespace)
      prior.onsuccess = () => {
        const saved = savedTxsOf((prior.result as SnapshotRecord | undefined)?.txs)
        if (saved) record.txs = saved
        store.put(record)
      }
    } else {
      store.put(record)
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('Saved Activity history write failed'))
    tx.onabort = () => reject(tx.error ?? new Error('Saved Activity history write aborted'))
  })
}

export function resetActivityLedgerStoreForTests(): void {
  opening = null
}
