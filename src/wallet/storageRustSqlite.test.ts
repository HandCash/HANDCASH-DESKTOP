import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SetupClient,
  StorageIdb,
  StorageRustSqlite,
  WalletStorageManager,
  migrateLegacyIdbToRustSqlite,
  type ToolboxDbBridge,
} from '@handcash/wallet-engine'
import { listOutputsInSlices, NATIVE_SQLITE_SUB_READ_ROWS } from './basketSubReads'
import { purgeRetiredProofRequests } from './provenTxReqPurge'

type RecordedCall = { dbName: string; op: string; params: Record<string, unknown> }

function createMockToolboxBridge(
  handlers: Record<string, (params: Record<string, unknown>) => unknown> = {},
): { bridge: ToolboxDbBridge; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  let nextTrx = 1
  const meta = new Map<string, string>()
  const tables = new Map<string, Record<string, unknown>[]>()
  let settings: Record<string, unknown> | null = null

  const bridge: ToolboxDbBridge = {
    async call<T = unknown>(dbName: string, op: string, params: Record<string, unknown> = {}): Promise<T> {
      calls.push({ dbName, op, params })
      if (handlers[op]) return handlers[op](params) as T
      switch (op) {
        case 'open': {
          if (!settings && params.storageIdentityKey) {
            settings = {
              storageIdentityKey: params.storageIdentityKey,
              storageName: params.storageName ?? dbName,
              chain: params.chain ?? 'main',
              dbtype: 'SQLite',
              maxOutputScript: params.maxOutputScript ?? 1024,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }
          }
          const counts: Record<string, number> = {}
          for (const [k, rows] of tables.entries()) counts[k] = rows.length
          return {
            settings,
            migratedFromIdb: meta.get('migrated_from_idb') === '1',
            counts,
          } as T
        }
        case 'readSettings':
          return settings as T
        case 'beginTx':
          return { trxId: nextTrx++ } as T
        case 'commitTx':
        case 'rollbackTx':
        case 'close':
          return true as T
        case 'setMeta':
          meta.set(String(params.key), String(params.value))
          return true as T
        case 'importMigrationChunk': {
          const table = String(params.table)
          const rows = (params.rows as Record<string, unknown>[]) ?? []
          if (table === 'settings' && rows[0]) {
            settings = { ...rows[0], dbtype: 'SQLite' }
          } else {
            const list = tables.get(table) ?? []
            list.push(...rows)
            tables.set(table, list)
          }
          return { imported: rows.length } as T
        }
        case 'tableCounts': {
          const counts: Record<string, number> = {}
          for (const [k, rows] of tables.entries()) counts[k] = rows.length
          return counts as T
        }
        default:
          return null as T
      }
    },
  }
  return { bridge, calls }
}

describe('StorageRustSqlite', () => {
  const originalWindow = globalThis.window

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window
    } else {
      ;(globalThis as { window?: unknown }).window = originalWindow
    }
  })

  it('encodes binary fields as base64, preserves explicit undefined-as-null on updates, and hydrates Dates/bytes', async () => {
    const { bridge, calls } = createMockToolboxBridge({
      insertOutput: () => 42,
      updateOutput: () => 1,
      findOutputs: () => [
        {
          outputId: 42,
          created_at: '2026-11-21T10:00:00.000Z',
          updated_at: '2026-11-21T10:00:00.000Z',
          userId: 1,
          transactionId: 7,
          basketId: 2,
          spendable: true,
          change: true,
          outputDescription: 'change',
          vout: 0,
          satoshis: 1234,
          providedBy: 'storage',
          purpose: 'change',
          type: 'P2PKH',
          txid: 'aa'.repeat(32),
          lockingScriptB64: Buffer.from([0x76, 0xa9, 0x14]).toString('base64'),
        },
      ],
      listOutputsFast: () => ({
        totalOutputs: 1,
        lastOutputId: 42,
        outputs: [{ outpoint: `${'aa'.repeat(32)}.0`, satoshis: 1234, spendable: true, tags: ['1sat'] }],
      }),
      sumSpendableOutputs: () => 99_999,
      purgeRetiredProofReqs: () => ({ purged: 3, bytes: 4096 }),
    })

    const storage = new StorageRustSqlite({
      chain: 'main',
      commissionSatoshis: 0,
      feeModel: { model: 'sat/kb', value: 100 },
      bridge,
    })
    await storage.migrate('test-db', '02stor')
    await storage.makeAvailable()
    expect(storage.getSettings().dbtype).toBe('SQLite')

    const insertedId = await storage.insertOutput({
      created_at: new Date('2026-11-21T10:00:00.000Z'),
      updated_at: new Date('2026-11-21T10:00:00.000Z'),
      outputId: 0,
      userId: 1,
      transactionId: 7,
      basketId: 2,
      spendable: true,
      change: true,
      outputDescription: 'change',
      vout: 0,
      satoshis: 1234,
      providedBy: 'storage',
      purpose: 'change',
      type: 'P2PKH',
      txid: 'aa'.repeat(32),
      lockingScript: [0x76, 0xa9, 0x14],
    })
    expect(insertedId).toBe(42)
    const insertCall = calls.find((c) => c.op === 'insertOutput')!
    expect((insertCall.params.row as Record<string, unknown>).lockingScriptB64).toBe(
      Buffer.from([0x76, 0xa9, 0x14]).toString('base64'),
    )
    expect((insertCall.params.row as Record<string, unknown>).lockingScript).toBeUndefined()

    // Explicit `spentBy: undefined` must serialize as `null` so SQLite clears spent_by = NULL!
    await storage.updateOutput(42, { spendable: true, spentBy: undefined })
    const updateCall = calls.find((c) => c.op === 'updateOutput')!
    expect((updateCall.params.update as Record<string, unknown>).spentBy).toBeNull()
    expect((updateCall.params.update as Record<string, unknown>).spendable).toBe(true)

    const found = await storage.findOutputs({ partial: { outputId: 42 } })
    expect(found).toHaveLength(1)
    expect(found[0]!.created_at).toBeInstanceOf(Date)
    expect(found[0]!.lockingScript).toEqual([0x76, 0xa9, 0x14])

    const listRes = await storage.listOutputs(
      { identityKey: '02u', userId: 1, isActive: true },
      { basket: '1sat', limit: 250, offset: -1, tags: [], tagQueryMode: 'any', include: 'locking scripts', includeCustomInstructions: false, includeTags: true, includeLabels: false, includeTransactions: false, includeLockingScripts: false, seekPermission: false, knownTxids: [] },
    )
    expect(listRes.totalOutputs).toBe(1)
    expect((listRes as { lastOutputId?: number }).lastOutputId).toBe(42)

    const purge = await purgeRetiredProofRequests(storage, Date.now())
    expect(purge).toEqual({ purged: 3, bytes: 4096 })
  })

  it('allows concurrent WAL reads in WalletStorageManager while prioritizing writers', async () => {
    const events: string[] = []
    let releaseRead1!: () => void
    const read1Gate = new Promise<void>((r) => {
      releaseRead1 = r
    })
    let readCount = 0

    const { bridge } = createMockToolboxBridge({
      findUsers: () => [
        {
          userId: 1,
          created_at: '2026-11-21T10:00:00.000Z',
          updated_at: '2026-11-21T10:00:00.000Z',
          identityKey: '02u',
          activeStorage: '02stor',
        },
      ],
      listOutputsFast: () => ({ totalOutputs: 0, outputs: [] }),
    })

    const storage = new StorageRustSqlite({
      chain: 'main',
      commissionSatoshis: 0,
      feeModel: { model: 'sat/kb', value: 100 },
      bridge,
    })
    await storage.migrate('rw-test', '02stor')
    await storage.makeAvailable()

    const mgr = new WalletStorageManager('02u', storage)
    await mgr.makeAvailable()

    const r1 = mgr.runAsReader(async () => {
      readCount++
      events.push('r1-start')
      await read1Gate
      events.push('r1-end')
    })
    const r2 = mgr.runAsReader(async () => {
      readCount++
      events.push('r2-start')
      events.push('r2-end')
    })

    // Wait a microtask tick — r2 must enter and finish BEFORE r1 releases!
    await new Promise((r) => setTimeout(r, 10))
    expect(readCount).toBe(2)
    expect(events).toEqual(['r1-start', 'r2-start', 'r2-end'])

    // Writer must wait for r1 to drain, and block r3 until writer finishes.
    const w1 = mgr.runAsWriter(async () => {
      events.push('w1-start')
      await new Promise((r) => setTimeout(r, 5))
      events.push('w1-end')
    })
    const r3 = mgr.runAsReader(async () => {
      events.push('r3-start')
    })

    releaseRead1()
    await Promise.all([r1, r2, w1, r3])
    expect(events).toEqual(['r1-start', 'r2-start', 'r2-end', 'r1-end', 'w1-start', 'w1-end', 'r3-start'])
  })

  it('migrates legacy IndexedDB into StorageRustSqlite non-destructively with count verification', async () => {
    const dbName = `legacy-migrate-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const legacy = new StorageIdb({
      chain: 'main',
      commissionSatoshis: 0,
      feeModel: { model: 'sat/kb', value: 100 },
    })
    await legacy.migrate(dbName, '02legacy-stor')
    await legacy.makeAvailable()
    const { user } = await legacy.findOrInsertUser('02legacy-user')
    const txId = await legacy.insertTransaction({
      created_at: new Date(),
      updated_at: new Date(),
      transactionId: 0,
      userId: user.userId,
      status: 'completed',
      reference: 'legacy-ref-1',
      isOutgoing: false,
      satoshis: 5000,
      description: 'seeded',
      txid: 'bb'.repeat(32),
    })
    await legacy.insertOutput({
      created_at: new Date(),
      updated_at: new Date(),
      outputId: 0,
      userId: user.userId,
      transactionId: txId,
      basketId: 1,
      spendable: true,
      change: true,
      outputDescription: 'coin',
      vout: 0,
      satoshis: 5000,
      providedBy: 'storage',
      purpose: 'change',
      type: 'P2PKH',
      txid: 'bb'.repeat(32),
      lockingScript: [0x76, 0xa9],
    })
    await legacy.destroy()

    const { bridge, calls } = createMockToolboxBridge()
    const sqlite = new StorageRustSqlite({
      chain: 'main',
      commissionSatoshis: 0,
      feeModel: { model: 'sat/kb', value: 100 },
      bridge,
    })
    await sqlite.migrate(dbName, '02placeholder-key')
    await migrateLegacyIdbToRustSqlite(sqlite, dbName)

    // Preserved legacy storageIdentityKey and switched dbtype to SQLite!
    expect(sqlite.getSettings().storageIdentityKey).toBe('02legacy-stor')
    expect(sqlite.getSettings().dbtype).toBe('SQLite')

    const importedTables = calls.filter((c) => c.op === 'importMigrationChunk').map((c) => c.params.table)
    expect(importedTables).toContain('settings')
    expect(importedTables).toContain('users')
    expect(importedTables).toContain('output_baskets')
    expect(importedTables).toContain('transactions')
    expect(importedTables).toContain('outputs')
    expect(calls.some((c) => c.op === 'commitTx')).toBe(true)

    // Non-destructive: legacy IndexedDB still holds the user untouched.
    const verifyLegacy = new StorageIdb({
      chain: 'main',
      commissionSatoshis: 0,
      feeModel: { model: 'sat/kb', value: 100 },
    })
    await verifyLegacy.migrate(dbName, '02ignored')
    expect(await verifyLegacy.countOutputs({ partial: {} })).toBe(1)
    await verifyLegacy.destroy()
    await verifyLegacy.dropAllData()
  })

  it('SetupClient.createStorageIdb selects StorageRustSqlite when native toolboxDb bridge is present and scales basket slices', async () => {
    const { bridge } = createMockToolboxBridge()
    ;(globalThis as { window?: unknown }).window = {
      handcash: { toolboxDb: bridge },
    }

    const storage = await SetupClient.createStorageIdb({
      chain: 'main',
      rootKeyHex: '11'.repeat(32),
      databaseName: `setup-sqlite-${Date.now()}`,
    })
    expect(storage).toBeInstanceOf(StorageRustSqlite)
    expect(storage.getSettings().dbtype).toBe('SQLite')

    const seenLimits: number[] = []
    const res = await listOutputsInSlices(
      async (args) => {
        seenLimits.push(args.limit ?? 0)
        return {
          outputs: Array.from({ length: Math.min(args.limit ?? 0, 100) }, (_, i) => ({ id: i })),
          totalOutputs: 100,
        }
      },
      { limit: 500, offset: -1 },
      { inSpend: true },
    )
    expect(seenLimits).toEqual([NATIVE_SQLITE_SUB_READ_ROWS])
    expect(res.slices).toBe(1)
    expect(vi.isMockFunction(bridge.call)).toBe(false)
  })
})
