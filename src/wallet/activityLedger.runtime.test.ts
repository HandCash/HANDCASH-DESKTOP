import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WalletRuntime } from './walletRuntime'
const control = vi.hoisted(() => ({ current: null as WalletRuntime | null }))
vi.mock('./walletRuntime', () => ({
  getWalletRuntime: () => control.current,
  runtimeIsCurrent: (runtime: WalletRuntime) => runtime === control.current && !runtime.signal.aborted,
}))
vi.mock('./walletCoordinator', () => ({ shouldYieldChainIngestToSpend: () => false, spendNeedsStorage: () => false }))
vi.mock('./ghostTxSuppress', () => ({ isGhostTxSuppressed: () => false }))
import { ledgerActivityById, ledgerActivitySnapshot, noteCommittedItemLegs, publishActivityLedger, refreshActivityLedger, resetActivityLedgerForTests, subscribeActivityLedger } from './activityLedger'
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
  beforeEach(() => { resetActivityLedgerForTests(); control.current = null })
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
  it('coalesces reads only for the same runtime and scopes all tables to its user', async () => {
    const owner = wallet('owner'); control.current = owner.runtime
    const first = refreshActivityLedger(owner.runtime)
    expect(refreshActivityLedger(owner.runtime)).toBe(first)
    await first
    expect(owner.provider.findUsers).toHaveBeenCalledWith({ partial: { identityKey: 'owner' } })
    expect(owner.provider.findTransactions).toHaveBeenCalledWith(expect.objectContaining({ partial: { userId: 9 }, noRawTx: true }))
    expect(owner.provider.findOutputBaskets).toHaveBeenCalledWith({ partial: { userId: 9 } })
    expect(owner.provider.findOutputs).toHaveBeenCalledWith({ partial: { userId: 9, basketId: 3 }, noScript: true })
  })
  it('shows a migrate’s legs before the ledger re-reads, then yields them to the read', () => {
    const owner = wallet('owner'); control.current = owner.runtime
    const heard = vi.fn(); const off = subscribeActivityLedger(heard)
    noteCommittedItemLegs([
      { txid: txid(7), vout: 1, origin: `${txid(5)}.0`, name: 'Fox #1' },
      { txid: txid(7), vout: 0, origin: null, name: null },
    ], 50)
    expect(heard).toHaveBeenCalledOnce()
    const shown = ledgerActivitySnapshot()
    expect(shown).toBe(ledgerActivitySnapshot())
    expect(shown.map(row => row.id)).toEqual([`ledger:${txid(7)}:${txid(7)}.1`, `ledger:${txid(7)}:${txid(7)}.0`])
    expect(shown[0]).toMatchObject({ kind: 'earned', method: 'receive-collectable', note: 'Migrate 2 ordinals from phrase', item: { name: 'Fox #1', origin: `${txid(5)}_0` } })
    expect(shown[1]!.item).toMatchObject({ name: 'Collectable', origin: `${txid(7)}_0` })
    const real = { ...shown[0]!, at: 49, note: 'Migrate 2 ordinals from phrase' }
    publishActivityLedger('owner', [real])
    expect(ledgerActivitySnapshot().map(row => row.id)).toEqual([real.id, shown[1]!.id])
    expect(ledgerActivityById(real.id)!.at).toBe(49)
    control.current = wallet('other').runtime
    expect(ledgerActivitySnapshot()).toEqual([])
    off()
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
  it('shows a delayed-broadcast migrate that is still sending after a restart', async () => {
    const records = new Map<number, Record<string, unknown>>([
      [4, { transactionId: 4, txid: txid(4), satoshis: -30, isOutgoing: true, created_at: 40, status: 'sending', description: 'Migrate 25 ordinals from phrase' }],
      [5, { transactionId: 5, txid: txid(5), satoshis: 9, created_at: 50, status: 'unsigned' }],
    ])
    const owner = wallet('owner'); control.current = owner.runtime
    const provider = owner.provider as typeof owner.provider & { toDbTrx: unknown }
    provider.toDbTrx = () => ({
      objectStore: () => ({
        index: () => ({ getAllKeys: async ([status]: [string]) => [...records.values()].filter(r => r.status === status).map(r => r.transactionId) }),
        get: async (id: number) => records.get(id),
      }),
      done: Promise.resolve(),
    })
    await refreshActivityLedger(owner.runtime)
    expect(ledgerActivitySnapshot().map(row => row.txid)).toEqual([txid(4)])
  })
  it('refuses an ambiguous or missing wallet owner', async () => {
    const owner = wallet('owner'); control.current = owner.runtime
    owner.provider.findUsers.mockResolvedValueOnce([])
    await refreshActivityLedger(owner.runtime)
    expect(owner.provider.findTransactions).not.toHaveBeenCalled()
    expect(ledgerActivitySnapshot()).toEqual([])
  })
})
