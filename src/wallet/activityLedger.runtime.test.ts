import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WalletRuntime } from './walletRuntime'
const control = vi.hoisted(() => ({ current: null as WalletRuntime | null, spend: false }))
vi.mock('./walletRuntime', () => ({
  getWalletRuntime: () => control.current,
  runtimeIsCurrent: (runtime: WalletRuntime) => runtime === control.current && !runtime.signal.aborted,
}))
vi.mock('./walletCoordinator', () => ({
  foregroundSpendWaiting: () => control.spend,
}))
vi.mock('./ghostTxSuppress', () => ({ isGhostTxSuppressed: () => false }))
const jobs = vi.hoisted(() => new Map<string, string>())
vi.mock('./activityJobIndex', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./activityJobIndex')>()),
  jobOfTxid: (txid: string | undefined) => (txid ? jobs.get(txid) ?? null : null),
}))
const saved = vi.hoisted(() => new Map<string, { rows: unknown[] | null; txs: unknown }>())
vi.mock('./activityLedgerStore', () => ({
  loadLedgerSnapshot: async (namespace: string) => saved.get(namespace) ?? { rows: null, txs: null },
  saveLedgerRows: async (namespace: string, rows: unknown[], txs?: unknown) => {
    saved.set(namespace, { rows: [...rows], txs: txs === undefined ? saved.get(namespace)?.txs ?? null : txs })
  },
}))
import {
  ledgerActivitySnapshot,
  paintSavedActivityLedger,
  preloadActivityLedger,
  publishActivityLedger,
  refreshActivityLedger,
  resetActivityLedgerForRuntime,
  resetActivityLedgerForTests,
} from './activityLedger'
const txid = (n: number) => n.toString(16).padStart(64, '0')
function wallet(namespace: string, transactions: Promise<unknown[]> = Promise.resolve([])) {
  const provider = {
    findUsers: vi.fn(async () => [{ userId: 9 }]),
    findTransactions: vi.fn(async () => transactions),
    findOutputBaskets: vi.fn(async () => [{ basketId: 3, name: '1sat' }]),
    findOutputs: vi.fn(async () => []),
  }
  const runtime = {
    instance: { identityKey: namespace, wallet: { storage: { runAsStorageProvider: async (fn: (sp: typeof provider) => unknown) => fn(provider) } } },
    runtimeId: namespace, storageNamespace: namespace, generation: 1, signal: new AbortController().signal,
  } as unknown as WalletRuntime
  return { runtime, provider }
}
describe('Activity ledger runtime ownership', () => {
  beforeEach(() => { resetActivityLedgerForTests(); saved.clear(); jobs.clear(); control.current = null; control.spend = false })
  it('paints and saves import legs from their item outputs before the transaction records are read', async () => {
    const leg = txid(0xa1)
    jobs.set(leg, 'job:wallet-sweep:night')
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const owner = wallet('owner')
    const provider = owner.provider as typeof owner.provider & { toDbTrx: unknown }
    provider.toDbTrx = () => ({
      objectStore: () => ({
        index: () => ({ getAllKeys: async ([status]: [string]) => (status === 'completed' ? [7] : []) }),
        get: async () => {
          await gate
          return { transactionId: 7, txid: leg, satoshis: 0, created_at: 1_900, description: 'Migrate 2 ordinals from phrase' }
        },
      }),
      done: Promise.resolve(),
    })
    control.current = owner.runtime
    publishActivityLedger('owner', [{ id: 'ledger:' + txid(1), txid: txid(1), origin: 'handcash', kind: 'earned', method: 'receive', sats: 5, at: 1, note: 'Received coins' }])
    owner.provider.findOutputs.mockResolvedValueOnce([
      { transactionId: 7, txid: leg, vout: 1, basketId: 3, created_at: 2_000, customInstructions: '{"name":"Fox #2"}' },
      { transactionId: 7, txid: leg, vout: 0, basketId: 3, created_at: 2_000 },
      { transactionId: 8, txid: txid(0xb2), vout: 0, basketId: 3, created_at: 3_000 },
    ] as never)
    const read = refreshActivityLedger(owner.runtime)
    await vi.waitFor(() => expect(ledgerActivitySnapshot()).toHaveLength(3))
    expect(ledgerActivitySnapshot().slice(1)).toEqual([
      expect.objectContaining({ id: `ledger:${leg}:${leg}.0`, note: 'Migrate 2 ordinals from phrase', at: 2_000, kind: 'earned' }),
      expect.objectContaining({ id: `ledger:${leg}:${leg}.1`, item: expect.objectContaining({ name: 'Fox #2' }) }),
    ])
    resetActivityLedgerForRuntime()
    expect(saved.get('owner')?.rows).toHaveLength(3)

    release()
    await read
    expect(ledgerActivitySnapshot().map(row => [row.id, row.at]).sort()).toEqual([
      [`ledger:${leg}:${leg}.0`, 1_900],
      [`ledger:${leg}:${leg}.1`, 1_900],
    ])
  })
  it('a previous account read cannot suppress or overwrite the new account refresh', async () => {
    let finish!: (tx: unknown[]) => void
    const old = wallet('old', new Promise(resolve => { finish = resolve }))
    control.current = old.runtime
    const oldRead = refreshActivityLedger(old.runtime)
    const next = wallet('next', Promise.resolve([{ transactionId: 1, txid: txid(2), satoshis: 20, created_at: 10 }]))
    control.current = next.runtime
    await refreshActivityLedger(next.runtime)
    expect(ledgerActivitySnapshot().map(row => row.txid)).toEqual([txid(2)])
    finish([{ transactionId: 1, txid: txid(1), satoshis: 100, created_at: 10 }]); await oldRead
    expect(ledgerActivitySnapshot().map(row => row.txid)).toEqual([txid(2)])
    expect(next.provider.findTransactions).toHaveBeenCalledOnce()
  })
  it('lets a waiting send go first, then reads', async () => {
    vi.useFakeTimers()
    try {
      const owner = wallet('owner', Promise.resolve([{ transactionId: 1, txid: txid(1), satoshis: 5, created_at: 10 }]))
      control.current = owner.runtime
      control.spend = true
      const read = refreshActivityLedger(owner.runtime)
      await vi.advanceTimersByTimeAsync(4_000)
      expect(owner.provider.findUsers).not.toHaveBeenCalled()
      control.spend = false
      await vi.advanceTimersByTimeAsync(2_000)
      await read
      expect(owner.provider.findOutputs).toHaveBeenCalled()
      expect(ledgerActivitySnapshot().map(row => row.txid)).toEqual([txid(1)])
    } finally {
      vi.useRealTimers()
    }
  })
  it('a send that never stops waiting cannot keep the ledger at its last read', async () => {
    vi.useFakeTimers()
    try {
      const owner = wallet('owner', Promise.resolve([{ transactionId: 1, txid: txid(1), satoshis: 5, created_at: 10 }]))
      control.current = owner.runtime
      control.spend = true
      const read = refreshActivityLedger(owner.runtime)
      await vi.advanceTimersByTimeAsync(70_000)
      await read
      expect(ledgerActivitySnapshot().map(row => row.txid)).toEqual([txid(1)])
    } finally {
      vi.useRealTimers()
    }
  })
  it('coalesces reads only for the same runtime and scopes all tables to its user', async () => {
    const owner = wallet('owner'); control.current = owner.runtime
    const first = refreshActivityLedger(owner.runtime)
    expect(refreshActivityLedger(owner.runtime)).toBe(first)
    await first
    expect(owner.provider.findUsers).toHaveBeenCalledWith({ partial: { identityKey: 'owner' } })
    expect(owner.provider.findTransactions).toHaveBeenCalledWith(expect.objectContaining({ partial: { userId: 9 }, noRawTx: true }))
    expect(owner.provider.findOutputBaskets).toHaveBeenCalledWith({ partial: { userId: 9 } })
    expect(owner.provider.findOutputs).toHaveBeenCalledWith({
      partial: { userId: 9, basketId: 3 },
      noScript: true,
      paged: { limit: 200, offset: 0 },
    })
  })
  it('publishes corrections to direction even when time, amount and description stay the same', () => {
    const owner = wallet('owner'); control.current = owner.runtime
    const row = { id: 'ledger:' + txid(1), txid: txid(1), origin: 'handcash', kind: 'spent' as const, method: 'send', sats: 10, at: 1, note: 'Transfer' }
    publishActivityLedger('owner', [row])
    publishActivityLedger('owner', [{ ...row, kind: 'earned', method: 'receive' }])
    expect(ledgerActivitySnapshot()[0]).toMatchObject({ kind: 'earned', method: 'receive' })
  })
  it('on IndexedDB storage fetches only transactions this session has not read', async () => {
    const records = new Map<number, Record<string, unknown>>([
      [1, { transactionId: 1, txid: txid(1), satoshis: 100, created_at: 10, status: 'completed', rawTx: [1, 2, 3] }],
      [2, { transactionId: 2, txid: txid(2), satoshis: -40, isOutgoing: true, created_at: 20, status: 'unproven' }],
    ])
    const gets: number[] = []
    const owner = wallet('owner'); control.current = owner.runtime
    const provider = owner.provider as typeof owner.provider & { toDbTrx: unknown }
    provider.toDbTrx = () => ({
      objectStore: () => ({
        index: (name: string) => {
          expect(name).toBe('status_userId')
          return { getAllKeys: async ([status, userId]: [string, number]) => {
            expect(userId).toBe(9)
            return [...records.values()].filter(r => r.status === status).map(r => r.transactionId)
          } }
        },
        get: async (id: number) => { gets.push(id); return records.get(id) },
      }),
      done: Promise.resolve(),
    })
    await refreshActivityLedger(owner.runtime)
    expect(ledgerActivitySnapshot().map(row => [row.txid, row.sats, row.kind])).toEqual([[txid(1), 100, 'earned'], [txid(2), 40, 'spent']])
    expect(owner.provider.findTransactions).not.toHaveBeenCalled()

    records.set(3, { transactionId: 3, txid: txid(3), satoshis: 7, created_at: 30, status: 'completed' })
    records.get(2)!.status = 'failed'
    gets.length = 0
    await refreshActivityLedger(owner.runtime)
    expect(gets).toEqual([3])
    expect(ledgerActivitySnapshot().map(row => row.txid)).toEqual([txid(1), txid(3)])

    gets.length = 0
    await refreshActivityLedger(owner.runtime, { full: true })
    expect(gets.sort()).toEqual([1, 3])
  })
  it('a launch reads only the transactions the last session had not, and rereads all when they disagree with storage', async () => {
    const records = new Map<number, Record<string, unknown>>([
      [1, { transactionId: 1, txid: txid(1), satoshis: 100, created_at: 10, status: 'completed', inputBEEF: [9, 9, 9] }],
      [2, { transactionId: 2, txid: txid(2), satoshis: -40, isOutgoing: true, created_at: 20, status: 'unproven' }],
    ])
    const gets: number[] = []
    const owner = wallet('owner'); control.current = owner.runtime
    const provider = owner.provider as typeof owner.provider & { toDbTrx: unknown }
    provider.toDbTrx = () => ({
      objectStore: () => ({
        index: () => ({ getAllKeys: async ([status]: [string]) =>
          [...records.values()].filter(r => r.status === status).map(r => r.transactionId) }),
        get: async (id: number) => { gets.push(id); return records.get(id) },
      }),
      done: Promise.resolve(),
    })
    await refreshActivityLedger(owner.runtime)
    expect(gets.sort()).toEqual([1, 2])
    resetActivityLedgerForRuntime()
    expect(saved.get('owner')?.txs).toMatchObject({ userId: 9 })

    resetActivityLedgerForTests()
    await preloadActivityLedger('owner')
    paintSavedActivityLedger(owner.runtime)
    records.set(3, { transactionId: 3, txid: txid(3), satoshis: 7, created_at: 30, status: 'completed' })
    gets.length = 0
    await refreshActivityLedger(owner.runtime)
    expect(gets).toEqual([3])
    expect(ledgerActivitySnapshot().map(row => row.txid)).toEqual([txid(1), txid(2), txid(3)])
    resetActivityLedgerForRuntime()

    resetActivityLedgerForTests()
    await preloadActivityLedger('owner')
    paintSavedActivityLedger(owner.runtime)
    records.set(1, { ...records.get(1)!, txid: txid(8) })
    owner.provider.findOutputs.mockResolvedValueOnce([{ transactionId: 1, txid: txid(8), basketId: 3, vout: 0 }] as never)
    gets.length = 0
    await refreshActivityLedger(owner.runtime)
    expect(gets.sort()).toEqual([1, 2, 3])
    expect(ledgerActivitySnapshot().map(row => row.txid)).toContain(txid(8))
  })
  it('refuses an ambiguous or missing wallet owner', async () => {
    const owner = wallet('owner'); control.current = owner.runtime
    owner.provider.findUsers.mockResolvedValueOnce([])
    await refreshActivityLedger(owner.runtime)
    expect(owner.provider.findTransactions).not.toHaveBeenCalled()
    expect(ledgerActivitySnapshot()).toEqual([])
  })
})
