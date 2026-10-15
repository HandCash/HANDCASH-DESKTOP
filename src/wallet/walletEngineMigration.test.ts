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

function document(sats = 21) {
  return {
    brc: 38,
    title: 'User Wallet Data Format',
    formatVersion: 1,
    exportedAt: '2026-10-15T00:00:00.000Z',
    sourceStorage: { chain: 'main' },
    user: {
      identityKey:
        '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
    },
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

describe('wallet engine migration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetWalletEngineMigrationForTests()
    mocks.durableGetItem.mockReturnValue(null)
    mocks.durableSetItem.mockReturnValue(true)
    mocks.createStorageIdb
      .mockResolvedValueOnce({ destroy: vi.fn() })
      .mockResolvedValueOnce({ destroy: vi.fn() })
    mocks.exportBRC38Json
      .mockResolvedValueOnce('source')
      .mockResolvedValueOnce('staged')
    mocks.parseBRC38Json
      .mockReturnValueOnce(document())
      .mockReturnValueOnce(document())
    mocks.importBRC38.mockResolvedValue({
      mode: 'merge',
      identityKey: document().user.identityKey,
      userId: 1,
      inserts: 1,
      updates: 0,
    })
  })

  it('selects a verified staging database and retains the original', async () => {
    await migrateWalletEngineStorage({
      chain: 'main',
      rootKeyHex,
      handle: 'alice',
      accountIndex: 0,
    })

    expect(mocks.importBRC38).toHaveBeenCalledOnce()
    expect(mocks.select).toHaveBeenCalledWith(
      { chain: 'main', handle: 'alice', accountIndex: 0 },
      expect.stringContaining('wallet-main-primary-restore-engine-v1-'),
    )
  })

  it('fails closed when staged custody facts differ', async () => {
    mocks.parseBRC38Json
      .mockReset()
      .mockReturnValueOnce(document())
      .mockReturnValueOnce(document(20))

    await expect(
      migrateWalletEngineStorage({
        chain: 'main',
        rootKeyHex,
        handle: 'alice',
      }),
    ).rejects.toThrow('verification failed')
    expect(mocks.select).not.toHaveBeenCalled()
  })
})
