import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createStorageIdb: vi.fn(),
  exportBRC38Json: vi.fn(),
  importBRC38: vi.fn(),
  parseBRC38Json: vi.fn(),
  select: vi.fn(),
  durableGetItem: vi.fn(),
  durableSetItem: vi.fn(),
}))

vi.mock('@handcash/wallet-engine', () => ({
  SetupClient: { createStorageIdb: mocks.createStorageIdb },
  exportBRC38Json: mocks.exportBRC38Json,
  importBRC38: mocks.importBRC38,
  parseBRC38Json: mocks.parseBRC38Json,
}))

vi.mock('./vaultAccounts', () => ({
  originalToolboxDatabaseName: () => 'wallet-main-primary',
  toolboxDatabaseName: () => 'wallet-main-primary',
  selectToolboxDatabase: mocks.select,
}))

vi.mock('./durableStorage', () => ({
  durableGetItem: mocks.durableGetItem,
  durableSetItem: mocks.durableSetItem,
}))

import {
  __resetWalletEngineMigrationForTests,
  migrateWalletEngineStorage,
} from './walletEngineMigration'

const rootKeyHex = '01'.padStart(64, '0')
const identityKey =
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

function document(sats = 21) {
  return {
    brc: 38,
    title: 'User Wallet Data Format',
    formatVersion: 1,
    exportedAt: '2026-10-15T00:00:00.000Z',
    sourceStorage: { chain: 'main' },
    user: { identityKey },
    tables: {
      provenTxs: [],
      provenTxReqs: [],
      outputBaskets: [],
      transactions: [{ txid: 'ab'.repeat(32), status: 'unproven' }],
      commissions: [],
      outputs: [
        {
          txid: 'ab'.repeat(32),
          vout: 0,
          satoshis: sats,
          spendable: true,
        },
      ],
      outputTags: [],
      outputTagMaps: [],
      txLabels: [],
      txLabelMaps: [],
      certificates: [],
      certificateFields: [],
      syncStates: [],
    },
  }
}

async function seedDatabase(name: string, users: Array<{ identityKey: string }> = []) {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(name, 6)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('users', { keyPath: 'userId', autoIncrement: true })
    }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const trx = db.transaction('users', 'readwrite')
      for (const user of users) trx.objectStore('users').put(user)
      trx.oncomplete = () => {
        db.close()
        resolve()
      }
    }
  })
}

async function storedNames(): Promise<string[]> {
  return (await indexedDB.databases()).map((row) => row.name ?? '').sort()
}

const run = () =>
  migrateWalletEngineStorage({ chain: 'main', rootKeyHex, handle: 'alice', accountIndex: 0 })

describe('wallet engine migration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    globalThis.indexedDB = new IDBFactory()
    __resetWalletEngineMigrationForTests()
    mocks.durableGetItem.mockReturnValue(null)
    mocks.durableSetItem.mockReturnValue(true)
    mocks.createStorageIdb
      .mockResolvedValueOnce({ destroy: vi.fn() })
      .mockResolvedValueOnce({ destroy: vi.fn() })
    mocks.exportBRC38Json.mockResolvedValueOnce('source').mockResolvedValueOnce('staged')
    mocks.parseBRC38Json.mockReturnValueOnce(document()).mockReturnValueOnce(document())
    mocks.importBRC38.mockResolvedValue({
      mode: 'merge',
      identityKey,
      userId: 1,
      inserts: 1,
      updates: 0,
    })
  })

  it('adopts an account already in its own database without copying it', async () => {
    await seedDatabase('wallet-main-primary', [{ identityKey }])

    await run()

    expect(mocks.createStorageIdb).not.toHaveBeenCalled()
    expect(mocks.exportBRC38Json).not.toHaveBeenCalled()
    expect(mocks.select).not.toHaveBeenCalled()
    expect(mocks.durableSetItem).toHaveBeenCalledWith(
      expect.any(String),
      'wallet-main-primary',
    )
  })

  it('drops a staging copy an interrupted run left behind', async () => {
    await seedDatabase('wallet-main-primary', [{ identityKey }])
    await seedDatabase('wallet-main-primary-restore-engine-v1-abandoned')

    await run()

    expect(await storedNames()).toEqual(['wallet-main-primary'])
  })

  it('copies history held in the shared legacy database through a verified stage', async () => {
    await seedDatabase('wallet-toolbox-mainnet', [{ identityKey }])

    await run()

    expect(mocks.importBRC38).toHaveBeenCalledOnce()
    expect(mocks.select).toHaveBeenCalledWith(
      { chain: 'main', handle: 'alice', accountIndex: 0 },
      expect.stringContaining('wallet-main-primary-restore-engine-v1-'),
    )
  })

  it('fails closed when staged custody facts differ', async () => {
    await seedDatabase('wallet-toolbox-mainnet', [{ identityKey }])
    mocks.parseBRC38Json
      .mockReset()
      .mockReturnValueOnce(document())
      .mockReturnValueOnce(document(20))

    await expect(run()).rejects.toThrow('verification failed')
    expect(mocks.select).not.toHaveBeenCalled()
  })
})
