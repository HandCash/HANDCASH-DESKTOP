/**
 * BRC-255 chain facts on disk: transactions in Extended Format, the (txid,
 * asset) pairs this device validated, and where each deploy is. A txid
 * commits to its bytes and validity is a function of those bytes, so every
 * entry holds for every account and never goes stale. The account-scoped
 * state (outbox, peer frontier, issued records) lives in `state.ts`.
 */
import { Transaction, Utils } from '@bsv/sdk'
import { storageRegistry } from '../../storage/registry'

export const HCT_CHAIN_DB = storageRegistry.hctChain.key
const DB_VERSION = 1
const TXS = 'txs'
const VALID = 'valid'
const DEPLOYS = 'deploys'

type TxRecord = { txid: string; ef: string }
type ValidRecord = { key: string }
export type DeployRecord = { assetId: string; txid: string; vout: number }

const memoryTxs = new Map<string, Transaction>()
const memoryValid = new Set<string>()
let opening: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  if (opening) return opening
  opening = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('This device has no IndexedDB'))
      return
    }
    const req = indexedDB.open(HCT_CHAIN_DB, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(TXS)) db.createObjectStore(TXS, { keyPath: 'txid' })
      if (!db.objectStoreNames.contains(VALID)) db.createObjectStore(VALID, { keyPath: 'key' })
      if (!db.objectStoreNames.contains(DEPLOYS)) db.createObjectStore(DEPLOYS, { keyPath: 'assetId' })
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
    req.onerror = () => reject(req.error ?? new Error('Could not open the HCT store'))
  })
  opening.catch(() => {
    opening = null
  })
  return opening
}

function request<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest | void): Promise<T | undefined> {
  return open().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        const tx = db.transaction(store, mode)
        const req = run(tx.objectStore(store))
        let result: T | undefined
        if (req) req.onsuccess = () => (result = req.result as T)
        tx.oncomplete = () => resolve(result)
        tx.onerror = () => reject(tx.error ?? new Error(`HCT ${store} failed`))
        tx.onabort = () => reject(tx.error ?? new Error(`HCT ${store} aborted`))
      }),
  )
}

const validKey = (txid: string, assetId: string) => `${txid.toLowerCase()}:${assetId.toLowerCase()}`

/** Keep a transaction whose every source output is linked (Extended Format). */
export async function putHctTx(tx: Transaction): Promise<void> {
  const txid = String(tx.id('hex')).toLowerCase()
  let ef: string
  try {
    ef = Utils.toHex(tx.toEF())
  } catch {
    throw new Error(`Transaction ${txid} lacks a source output; only Extended Format is kept`)
  }
  memoryTxs.set(txid, tx)
  await request(TXS, 'readwrite', (s) => s.put({ txid, ef } satisfies TxRecord)).catch(() => {})
}

export async function getHctTx(txid: string): Promise<Transaction | null> {
  const key = txid.toLowerCase()
  const cached = memoryTxs.get(key)
  if (cached) return cached
  const record = await request<TxRecord>(TXS, 'readonly', (s) => s.get(key)).catch(() => undefined)
  if (!record?.ef) return null
  try {
    const tx = Transaction.fromHexEF(record.ef)
    if (String(tx.id('hex')).toLowerCase() !== key) return null
    memoryTxs.set(key, tx)
    return tx
  } catch {
    return null
  }
}

export function isHctValidatedSync(txid: string, assetId: string): boolean {
  return memoryValid.has(validKey(txid, assetId))
}

export async function isHctValidated(txid: string, assetId: string): Promise<boolean> {
  const key = validKey(txid, assetId)
  if (memoryValid.has(key)) return true
  const hit = await request<ValidRecord>(VALID, 'readonly', (s) => s.get(key)).catch(() => undefined)
  if (hit) memoryValid.add(key)
  return !!hit
}

/** Load the validated marks of these txids for one asset into memory, so a walk can stop on them. */
export async function primeHctValidated(txids: readonly string[], assetId: string): Promise<void> {
  await Promise.all(txids.map((txid) => isHctValidated(txid, assetId)))
}

export async function markHctValidated(txids: readonly string[], assetId: string): Promise<void> {
  if (txids.length === 0) return
  for (const txid of txids) memoryValid.add(validKey(txid, assetId))
  await request(VALID, 'readwrite', (s) => {
    for (const txid of txids) s.put({ key: validKey(txid, assetId) } satisfies ValidRecord)
  }).catch(() => {})
}

export async function putHctDeployRecord(record: DeployRecord): Promise<void> {
  await request(DEPLOYS, 'readwrite', (s) => s.put(record)).catch(() => {})
}

export async function getHctDeployRecord(assetId: string): Promise<DeployRecord | null> {
  return (await request<DeployRecord>(DEPLOYS, 'readonly', (s) => s.get(assetId.toLowerCase())).catch(() => undefined)) ?? null
}

export function resetHctStoreForTests(): void {
  opening = null
  memoryTxs.clear()
  memoryValid.clear()
}
