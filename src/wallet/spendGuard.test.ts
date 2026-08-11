import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchBalanceSats = vi.fn(async () => 12_345)
const assertOnlineForPayment = vi.fn(() => undefined)

vi.mock('./paymentPolicy', () => ({
  assertOnlineForPayment: () => assertOnlineForPayment(),
}))

vi.mock('./session', () => ({
  getActiveWallet: () => ({
    wallet: {},
    services: {},
    rootKeyHex: '00',
    identityKey: '02',
    address: '1abc',
    handle: 'test',
    chain: 'main',
  }),
  fetchBalanceSats: () => fetchBalanceSats(),
}))

vi.mock('./walletCoordinator', () => ({
  runExclusiveSpend: async <T>(
    fn: () => Promise<T>,
    acquireLease: () => Promise<() => Promise<void>>,
  ) => {
    const release = await acquireLease()
    try {
      return await fn()
    } finally {
      await release()
    }
  },
}))

vi.mock('./spendLease', () => ({
  acquireSpendLease: async () => async () => undefined,
}))

describe('refreshSpendableBalance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchBalanceSats.mockResolvedValue(12_345)
  })

  it('reads local toolbox balance without chain ingest', async () => {
    const { refreshSpendableBalance } = await import('./spendGuard')
    await expect(refreshSpendableBalance()).resolves.toBe(12_345)
    expect(fetchBalanceSats).toHaveBeenCalledTimes(1)
    expect(assertOnlineForPayment).toHaveBeenCalledTimes(1)
  })

  it('assertSendableBalance refuses when local funds are short', async () => {
    fetchBalanceSats.mockResolvedValue(100)
    const { assertSendableBalance } = await import('./spendGuard')
    await expect(assertSendableBalance(500)).rejects.toThrow(/Insufficient balance/)
  })
})
