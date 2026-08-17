/**
 * Persist headless live-test IndexedDB + localStorage across processes.
 *
 * The live harness uses fake-indexeddb. Without a dump, a new process boots a
 * blank wallet, scans only the P2PKH deposit address, and treats swept change
 * as gone. Same keys still own that change — this file is the missing disk.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const LIVE_IDB_PATH = resolve(process.cwd(), '.live-idb.json')

type StoreIndexDump = {
  name: string
  keyPath: string | string[]
  unique: boolean
  multiEntry: boolean
}

type StoreDump = {
  keyPath: string | string[] | null
  autoIncrement: boolean
  indexes: StoreIndexDump[]
  records: Array<{ key: unknown; value: unknown }>
}

type DatabaseDump = {
  version: number
  stores: Record<string, StoreDump>
}

export type LiveWalletStateDump = {
  v: 1
  databases: Record<string, DatabaseDump>
  localStorage: Record<string, string>
}

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('idb request failed'))
  })
}

function encode(value: unknown): unknown {
  if (value instanceof Date) return { __hcType: 'date', d: value.toISOString() }
  if (value instanceof ArrayBuffer) {
    return { __hcType: 'ab', d: Buffer.from(value).toString('base64') }
  }
  if (value instanceof Uint8Array) {
    return { __hcType: 'u8', d: Buffer.from(value).toString('base64') }
  }
  if (Array.isArray(value)) return value.map(encode)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = encode(v)
    }
    return out
  }
  return value
}

function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode)
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>
    if (rec.__hcType === 'date' && typeof rec.d === 'string') return new Date(rec.d)
    if (rec.__hcType === 'u8' && typeof rec.d === 'string') {
      return new Uint8Array(Buffer.from(rec.d, 'base64'))
    }
    if (rec.__hcType === 'ab' && typeof rec.d === 'string') {
      return Buffer.from(rec.d, 'base64').buffer
    }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(rec)) out[k] = decode(v)
    return out
  }
  return value
}

/** @internal test seam */
export const liveIdbCodec = { encode, decode }

function snapshotLocalStorage(): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    const storage = globalThis.localStorage
    if (!storage) return out
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i)
      if (!key) continue
      const value = storage.getItem(key)
      if (value != null) out[key] = value
    }
  } catch {
    // headless storage not installed
  }
  return out
}

function restoreLocalStorage(data: Record<string, string>): void {
  try {
    const storage = globalThis.localStorage
    if (!storage) return
    storage.clear()
    for (const [key, value] of Object.entries(data)) storage.setItem(key, value)
  } catch {
    // ignore
  }
}

async function listDatabaseNames(): Promise<string[]> {
  if (typeof indexedDB === 'undefined') return []
  if (typeof indexedDB.databases !== 'function') return []
  const listed = await indexedDB.databases()
  return listed.map((d) => d.name).filter((n): n is string => Boolean(n))
}

async function openExisting(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error(`open ${name} failed`))
  })
}

async function dumpStore(db: IDBDatabase, storeName: string): Promise<StoreDump> {
  const tx = db.transaction(storeName, 'readonly')
  const store = tx.objectStore(storeName)
  const indexes: StoreIndexDump[] = []
  for (let i = 0; i < store.indexNames.length; i += 1) {
    const name = store.indexNames[i]
    if (!name) continue
    const idx = store.index(name)
    indexes.push({
      name,
      keyPath: idx.keyPath as string | string[],
      unique: idx.unique,
      multiEntry: idx.multiEntry,
    })
  }
  const [keys, values] = await Promise.all([
    idbRequest(store.getAllKeys()) as Promise<IDBValidKey[]>,
    idbRequest(store.getAll()),
  ])
  const records = keys.map((key, i) => ({
    key: encode(key),
    value: encode(values[i]),
  }))
  return {
    keyPath: (store.keyPath as string | string[] | null) ?? null,
    autoIncrement: Boolean(store.autoIncrement),
    indexes,
    records,
  }
}

export async function dumpLiveWalletState(path = LIVE_IDB_PATH): Promise<number> {
  if (typeof indexedDB === 'undefined') return 0
  const names = await listDatabaseNames()
  const databases: Record<string, DatabaseDump> = {}
  for (const name of names) {
    const db = await openExisting(name)
    try {
      const stores: Record<string, StoreDump> = {}
      for (let i = 0; i < db.objectStoreNames.length; i += 1) {
        const storeName = db.objectStoreNames[i]
        if (storeName) stores[storeName] = await dumpStore(db, storeName)
      }
      databases[name] = { version: db.version, stores }
    } finally {
      db.close()
    }
  }
  const dump: LiveWalletStateDump = {
    v: 1,
    databases,
    localStorage: snapshotLocalStorage(),
  }
  writeFileSync(path, JSON.stringify(dump))
  return names.length
}

function createStores(db: IDBDatabase, stores: Record<string, StoreDump>): void {
  for (const [storeName, spec] of Object.entries(stores)) {
    if (db.objectStoreNames.contains(storeName)) continue
    const args: IDBObjectStoreParameters = {
      autoIncrement: spec.autoIncrement,
    }
    if (spec.keyPath != null) args.keyPath = spec.keyPath
    const store = db.createObjectStore(storeName, args)
    for (const idx of spec.indexes) {
      store.createIndex(idx.name, idx.keyPath, {
        unique: idx.unique,
        multiEntry: idx.multiEntry,
      })
    }
  }
}

async function restoreDatabase(name: string, dump: DatabaseDump): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(name, dump.version)
    req.onupgradeneeded = () => {
      if (req.result) createStores(req.result, dump.stores)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error(`restore open ${name} failed`))
  })
  try {
    const storeNames = Object.keys(dump.stores)
    if (storeNames.length === 0) return
    const tx = db.transaction(storeNames, 'readwrite')
    await Promise.all(
      storeNames.map(async (storeName) => {
        const spec = dump.stores[storeName]
        if (!spec) return
        const store = tx.objectStore(storeName)
        store.clear()
        for (const rec of spec.records) {
          const value = decode(rec.value)
          const key = decode(rec.key) as IDBValidKey
          if (spec.keyPath == null) store.put(value, key)
          else store.put(value)
        }
      }),
    )
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error(`restore ${name} txn failed`))
      tx.onabort = () => reject(tx.error ?? new Error(`restore ${name} aborted`))
    })
  } finally {
    db.close()
  }
}

export async function restoreLiveWalletState(path = LIVE_IDB_PATH): Promise<number> {
  if (!existsSync(path) || typeof indexedDB === 'undefined') return 0
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LiveWalletStateDump>
  if (parsed.v !== 1 || !parsed.databases) return 0
  restoreLocalStorage(parsed.localStorage ?? {})
  const names = Object.keys(parsed.databases)
  for (const name of names) {
    const dbDump = parsed.databases[name]
    if (dbDump) await restoreDatabase(name, dbDump)
  }
  return names.length
}
