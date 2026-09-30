import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WalletRuntime } from './walletRuntime'
const control = vi.hoisted(() => ({ current: null as WalletRuntime | null }))
vi.mock('./walletRuntime', () => ({
  getWalletRuntime: () => control.current,
  runtimeIsCurrent: (runtime: WalletRuntime) => runtime === control.current && !runtime.signal.aborted,
}))
vi.mock('./walletCoordinator', () => ({ shouldYieldChainIngestToSpend: () => false, spendNeedsStorage: () => false }))
vi.mock('./ghostTxSuppress', () => ({ isGhostTxSuppressed: () => false }))
import { ledgerActivitySnapshot, publishActivityLedger, refreshActivityLedger, resetActivityLedgerForTests } from './activityLedger'
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
  it('publishes corrections to direction even when time, amount and description stay the same', () => {
    const owner = wallet('owner'); control.current = owner.runtime
    const row = { id: 'ledger:' + txid(1), txid: txid(1), origin: 'handcash', kind: 'spent' as const, method: 'send', sats: 10, at: 1, note: 'Transfer' }
    publishActivityLedger('owner', [row])
    publishActivityLedger('owner', [{ ...row, kind: 'earned', method: 'receive' }])
    expect(ledgerActivitySnapshot()[0]).toMatchObject({ kind: 'earned', method: 'receive' })
  })
  it('refuses an ambiguous or missing wallet owner', async () => {
    const owner = wallet('owner'); control.current = owner.runtime
    owner.provider.findUsers.mockResolvedValueOnce([])
    await refreshActivityLedger(owner.runtime)
    expect(owner.provider.findTransactions).not.toHaveBeenCalled()
    expect(ledgerActivitySnapshot()).toEqual([])
  })
})
