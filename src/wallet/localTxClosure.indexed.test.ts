import 'fake-indexeddb/auto'
import { openDB, type IDBPDatabase } from 'idb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { P2PKH, PrivateKey, Transaction } from '@bsv/sdk'
import { __resetTxClosureMemoForTests, failOrphanedLocalTxs } from './localTxClosure'

vi.mock('./legacyScan', () => ({ txExistsOnChain: async () => null }))

/** A txid commits to its bytes, so the saved parents store must never see one reused with other bytes. */
const freshTxid = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('')
const E = 'e'.repeat(64)
let A = freshTxid()

function rawTxSpending(parents: readonly string[]): number[] {
  const key = PrivateKey.fromRandom()
  const tx = new Transaction()
  for (const parent of parents) {
    tx.addInput({ sourceTXID: parent, sourceOutputIndex: 0, unlockingScript: new P2PKH().lock(key.toAddress()) })
  }
  tx.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(key.toAddress()) })
  return tx.toBinary()
}

type Row = { transactionId: number; userId: number; txid: string; status: string; rawTx?: number[] }

let dbCount = 0

async function toolboxDb(rows: Row[]): Promise<IDBPDatabase> {
  const db = await openDB(`toolbox-${dbCount++}`, 1, {
    upgrade(up) {
      const store = up.createObjectStore('transactions', { keyPath: 'transactionId' })
      store.createIndex('status', 'status')
      store.createIndex('txid_userId', ['txid', 'userId'])
    },
  })
  for (const row of rows) await db.put('transactions', row)
  return db
}

/** A `StorageIdb`-shaped provider over a real IndexedDB, counting whole-record reads. */
function provider(db: IDBPDatabase) {
  const counts = { recordReads: 0 }
  const sp = {
    toDbTrx: (stores: string[], mode: 'readonly' | 'readwrite') => {
      const trx = db.transaction(stores, mode)
      const objectStore = trx.objectStore.bind(trx)
      return Object.assign(trx, {
        objectStore: (name: string) => {
          const store = objectStore(name)
          const get = store.get.bind(store)
          return Object.assign(store, {
            get: (key: IDBValidKey) => {
              counts.recordReads += 1
              return get(key)
            },
          })
        },
      })
    },
    updateTransactionStatus: async (status: string, transactionId: number) => {
      const row = (await db.get('transactions', transactionId)) as Row
      await db.put('transactions', { ...row, status })
    },
    findOutputs: async () => [],
    updateOutput: async () => undefined,
  }
  return { sp, counts }
}

function wallet(sp: unknown) {
  const held = { now: false, duringRecordRead: [] as boolean[] }
  return {
    held,
    active: {
      chain: 'main' as const,
      wallet: {
        storage: {
          runAsStorageProvider: async <T,>(fn: (sp: unknown) => Promise<T>): Promise<T> => {
            held.now = true
            try {
              return await fn(sp)
            } finally {
              held.now = false
            }
          },
        },
      },
    },
  }
}

beforeEach(() => {
  __resetTxClosureMemoForTests()
  A = freshTxid()
})

describe('failure closure on the IndexedDB provider', () => {
  it('reaches the same verdict from index keys, reading records outside the storage lock', async () => {
    const B = freshTxid()
    const D = freshTxid()
    const db = await toolboxDb([
      { transactionId: 1, userId: 1, txid: A, status: 'failed' },
      { transactionId: 2, userId: 1, txid: B, status: 'unproven', rawTx: rawTxSpending([A]) },
      { transactionId: 4, userId: 1, txid: D, status: 'unproven', rawTx: rawTxSpending([E]) },
    ])
    const { sp, counts } = provider(db)
    const { active, held } = wallet(sp)
    const lockedReads: boolean[] = []
    const toDbTrx = sp.toDbTrx
    sp.toDbTrx = (stores, mode) => {
      lockedReads.push(held.now)
      return toDbTrx(stores, mode)
    }

    const outcome = await failOrphanedLocalTxs(active)

    expect(outcome.failed).toEqual([B])
    expect(((await db.get('transactions', 2)) as Row).status).toBe('failed')
    expect(((await db.get('transactions', 4)) as Row).status).toBe('unproven')
    expect(counts.recordReads).toBe(2)
    // The first read and the raw fetch run unlocked; only the apply session re-reads under the lock.
    expect(lockedReads.slice(0, 2)).toEqual([false, false])
  })

  it('reads no record at all in a new session once parents are saved', async () => {
    const B = freshTxid()
    const C = freshTxid()
    const db = await toolboxDb([
      { transactionId: 1, userId: 1, txid: A, status: 'failed' },
      { transactionId: 2, userId: 1, txid: B, status: 'unproven', rawTx: rawTxSpending([E]) },
      { transactionId: 3, userId: 1, txid: C, status: 'nosend', rawTx: rawTxSpending([B]) },
    ])
    const first = provider(db)
    await failOrphanedLocalTxs(wallet(first.sp).active)
    expect(first.counts.recordReads).toBe(2)
    await vi.waitFor(async () => {
      __resetTxClosureMemoForTests()
      const next = provider(db)
      await failOrphanedLocalTxs(wallet(next.sp).active)
      expect(next.counts.recordReads).toBe(0)
    })
  })

  it('reads nothing past the status keys when no transaction has failed', async () => {
    const db = await toolboxDb([
      { transactionId: 2, userId: 1, txid: freshTxid(), status: 'unproven', rawTx: rawTxSpending([E]) },
    ])
    const { sp, counts } = provider(db)
    expect(await failOrphanedLocalTxs(wallet(sp).active)).toEqual({ failed: [], keptOnChain: [] })
    expect(counts.recordReads).toBe(0)
  })
})
