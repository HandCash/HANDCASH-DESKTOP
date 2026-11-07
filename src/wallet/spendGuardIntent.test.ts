import { describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ current: true, refusal: 'held-elsewhere' as string | null }))
const move = vi.hoisted(() => vi.fn(async () => { state.current = false; state.refusal = null }))
vi.mock('./session', () => ({
  getActiveWallet: () => null,
  coalescedBalanceRead: vi.fn(),
  debitProvenConfirmedSpendable: vi.fn(),
  peekProvenConfirmedSpendable: vi.fn(),
}))
vi.mock('./walletRuntime', () => ({
  getWalletRuntime: () => ({ instance: { identityKey: 'account-a', accountIndex: 0, vaultMaster: {} } }),
  assertRuntimeCurrent: () => { if (!state.current) throw new Error('Wallet runtime disposed') },
}))
vi.mock('./vaultAccountHolding', () => ({ activeAccountSpendRefusal: () => state.refusal }))
vi.mock('./spendAutoMove', () => ({ spendNeedsMove: () => true, moveActiveAccountForSpend: move }))
vi.mock('./accountMove', () => ({ ensureHoldingFresh: vi.fn() }))
vi.mock('./walletCoordinator', () => ({ runExclusiveSpend: vi.fn() }))

import { runExclusiveSpend } from './spendGuard'

describe('signing intent across an account move', () => {
  it('never runs a captured signing callback after switch or lock disposed its runtime', async () => {
    state.current = true
    state.refusal = 'held-elsewhere'
    const sign = vi.fn(async () => 'signed')
    await expect(runExclusiveSpend(sign)).rejects.toThrow('Wallet runtime disposed')
    expect(move).toHaveBeenCalledOnce()
    expect(sign).not.toHaveBeenCalled()
  })
})
