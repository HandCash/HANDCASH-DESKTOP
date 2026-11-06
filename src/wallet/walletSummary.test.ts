import { describe, expect, it, vi, beforeEach } from 'vitest'
import { readWalletSummary } from './walletSummary'

const hooks = vi.hoisted(() => ({ yield: vi.fn(), spend: vi.fn(() => false) }))
vi.mock('./yieldToUi', () => ({ yieldToUi: hooks.yield }))
vi.mock('./walletCoordinator', () => ({ foregroundSpendWaiting: hooks.spend }))

function fixture() {
  let locked = false
  const provider = {
    readCashSummaryPage: vi.fn()
      .mockResolvedValueOnce({ sats: 7, outputCount: 1, rowCount: 100, next: 100, revision: 2 })
      .mockResolvedValueOnce({ sats: 8, outputCount: 2, rowCount: 3, next: null, revision: 2 }),
    validateCashSummaryRevision: vi.fn(),
  }
  const wallet = { storage: { runAsStorageProvider: async <T>(read: (sp: typeof provider) => Promise<T>) => {
    expect(locked).toBe(false)
    locked = true
    try { return await read(provider) } finally { locked = false }
  } } }
  hooks.yield.mockImplementation(async () => { expect(locked).toBe(false) })
  return { wallet, provider }
}

describe('display summary paging', () => {
  beforeEach(() => { hooks.yield.mockReset(); hooks.spend.mockReturnValue(false) })

  it('releases the lock before yielding and validates the completed projection', async () => {
    const { wallet, provider } = fixture()
    await expect(readWalletSummary(wallet, 'owner', () => true)).resolves.toMatchObject({
      sats: 15, outputCount: 3, rowCount: 103,
    })
    expect(hooks.yield).toHaveBeenCalledTimes(1)
    expect(provider.readCashSummaryPage.mock.calls).toEqual([['owner', 0, undefined], ['owner', 100, 2]])
    expect(provider.validateCashSummaryRevision).toHaveBeenCalledWith(2)
  })

  it('does not queue the next page ahead of a waiting send', async () => {
    const { wallet, provider } = fixture()
    hooks.yield.mockImplementation(async () => { hooks.spend.mockReturnValue(true) })
    await expect(readWalletSummary(wallet, 'owner', () => true)).rejects.toThrow('send')
    expect(provider.readCashSummaryPage).toHaveBeenCalledTimes(1)
    expect(provider.validateCashSummaryRevision).not.toHaveBeenCalled()
  })

  it('discards the partial result after a session switch', async () => {
    const { wallet, provider } = fixture()
    let current = true
    hooks.yield.mockImplementation(async () => { current = false })
    await expect(readWalletSummary(wallet, 'owner', () => current)).rejects.toThrow('session')
    expect(provider.validateCashSummaryRevision).not.toHaveBeenCalled()
  })

  it('discards the partial result when storage rejects a changed revision', async () => {
    const { wallet, provider } = fixture()
    provider.readCashSummaryPage.mockReset()
      .mockResolvedValueOnce({ sats: 7, outputCount: 1, rowCount: 100, next: 100, revision: 2 })
      .mockRejectedValueOnce(new Error('changed'))
    await expect(readWalletSummary(wallet, 'owner', () => true)).rejects.toThrow('changed')
    expect(provider.validateCashSummaryRevision).not.toHaveBeenCalled()
  })
})
