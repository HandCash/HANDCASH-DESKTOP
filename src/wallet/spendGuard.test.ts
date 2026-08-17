import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchBalanceSats = vi.fn(
  async (_wallet?: unknown, opts?: { creditUnconfirmed?: boolean }) => {
    void opts
    return 12_345
  },
)
const assertOnlineForPayment = vi.fn(() => undefined)
const unconfirmedChangeSats = vi.fn(async (_opts?: { needAtLeast?: number }) => 0)

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
  fetchBalanceSats: (wallet?: unknown, opts?: { creditUnconfirmed?: boolean }) =>
    fetchBalanceSats(wallet, opts),
}))

vi.mock('./balanceView', () => ({
  unconfirmedChangeSats: (opts?: { needAtLeast?: number }) => unconfirmedChangeSats(opts),
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
    unconfirmedChangeSats.mockResolvedValue(0)
  })

  it('reads confirmed toolbox balance without the unconfirmed-change scan', async () => {
    const { refreshSpendableBalance } = await import('./spendGuard')
    await expect(refreshSpendableBalance()).resolves.toBe(12_345)
    expect(fetchBalanceSats).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ creditUnconfirmed: false }),
    )
    expect(unconfirmedChangeSats).not.toHaveBeenCalled()
    expect(assertOnlineForPayment).toHaveBeenCalledTimes(1)
  })

  it('assertSendableBalance skips the graveyard when confirmed covers the payment', async () => {
    fetchBalanceSats.mockResolvedValue(10_000)
    const { assertSendableBalance } = await import('./spendGuard')
    await expect(assertSendableBalance(500)).resolves.toBe(10_000)
    expect(unconfirmedChangeSats).not.toHaveBeenCalled()
  })

  it('assertSendableBalance credits unconfirmed change only for the shortfall', async () => {
    fetchBalanceSats.mockResolvedValue(100)
    unconfirmedChangeSats.mockResolvedValue(900)
    const { assertSendableBalance } = await import('./spendGuard')
    await expect(assertSendableBalance(500)).resolves.toBe(1_000)
    expect(unconfirmedChangeSats).toHaveBeenCalledWith({ needAtLeast: 400 })
  })

  it('assertSendableBalance refuses when confirmed + credit are still short', async () => {
    fetchBalanceSats.mockResolvedValue(100)
    unconfirmedChangeSats.mockResolvedValue(50)
    const { assertSendableBalance } = await import('./spendGuard')
    await expect(assertSendableBalance(500)).rejects.toThrow(/Insufficient balance/)
  })
})
