/**
 * The txids each transaction spends from, on disk, keyed by its own txid.
 *
 * A txid commits to its bytes, so an entry is a chain fact: it never goes
 * stale, holds for every account, and survives a store rewrite. It exists so
 * the failure closure does not clone every transaction record — raw bytes and
 * input BEEF included — on each launch just to learn what it spends.
 */
import { storageRegistry } from '../storage/registry'

/** The `handcash-brc100` prefix is what a wallet wipe deletes. */
export const TX_PARENTS_DB = storageRegistry.txParents.key
const DB_VERSION = 1
const STORE = 'parents'

type ParentsRecord = { txid: string; parents: string[] }

let opening: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  if (opening) return opening
  opening = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('This device has no IndexedDB'))
      return
    }
    const req = indexedDB.open(TX_PARENTS_DB, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'txid' })
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
    req.onerror = () => reject(req.error ?? new Error('Could not open the transaction parents store'))
  })
  opening.catch(() => {
    opening = null
  })
  return opening
}

const isTxid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)

/** Parents recorded for these txids. Txids never recorded are absent. */
export async function loadTxParents(txids: readonly string[]): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>()
  if (txids.length === 0) return found
  const db = await open()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const store = tx.objectStore(STORE)
    for (const txid of txids) {
      const req = store.get(txid)
      req.onsuccess = () => {
        const record = req.result as ParentsRecord | undefined
        if (record && Array.isArray(record.parents) && record.parents.every(isTxid)) {
          found.set(txid, record.parents)
        }
      }
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('Transaction parents read failed'))
    tx.onabort = () => reject(tx.error ?? new Error('Transaction parents read aborted'))
  })
  return found
}

export async function saveTxParents(entries: ReadonlyMap<string, readonly string[]>): Promise<void> {
  if (entries.size === 0) return
  const db = await open()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    for (const [txid, parents] of entries) store.put({ txid, parents: [...parents] } satisfies ParentsRecord)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('Transaction parents write failed'))
    tx.onabort = () => reject(tx.error ?? new Error('Transaction parents write aborted'))
  })
}

export function resetTxParentsStoreForTests(): void {
  opening = null
}
