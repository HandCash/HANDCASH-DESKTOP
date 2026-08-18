import { beforeEach, describe, expect, it, vi } from 'vitest'

type BalanceRead =
  | { kind: 'ok'; sats: number }
  | { kind: 'unavailable'; reason: 'noWallet' | 'storageUnreadable' }

const fetchBalanceRead = vi.fn(
  async (_wallet?: unknown, opts?: { creditUnconfirmed?: boolean }): Promise<BalanceRead> => {
    void opts
    return { kind: 'ok', sats: 12_345 }
  },
)

/** Mirror of the old numeric mock so each case reads as a plain balance. */
function mockConfirmed(sats: number): void {
  fetchBalanceRead.mockResolvedValue({ kind: 'ok', sats })
}
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
  fetchBalanceRead: (wallet?: unknown, opts?: { creditUnconfirmed?: boolean }) =>
    fetchBalanceRead(wallet, opts),
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
    mockConfirmed(12_345)
    unconfirmedChangeSats.mockResolvedValue(0)
  })

  it('reads confirmed toolbox balance without the unconfirmed-change scan', async () => {
    const { refreshSpendableBalance } = await import('./spendGuard')
    await expect(refreshSpendableBalance()).resolves.toBe(12_345)
    expect(fetchBalanceRead).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ creditUnconfirmed: false }),
    )
    expect(unconfirmedChangeSats).not.toHaveBeenCalled()
    expect(assertOnlineForPayment).toHaveBeenCalledTimes(1)
  })

  it('assertSendableBalance skips the graveyard when confirmed covers the payment', async () => {
    mockConfirmed(10_000)
    const { assertSendableBalance } = await import('./spendGuard')
    await expect(assertSendableBalance(500)).resolves.toBe(10_000)
    expect(unconfirmedChangeSats).not.toHaveBeenCalled()
  })

  it('assertSendableBalance credits unconfirmed change only for the shortfall', async () => {
    mockConfirmed(100)
    unconfirmedChangeSats.mockResolvedValue(900)
    const { assertSendableBalance } = await import('./spendGuard')
    await expect(assertSendableBalance(500)).resolves.toBe(1_000)
    expect(unconfirmedChangeSats).toHaveBeenCalledWith({ needAtLeast: 400 })
  })

  it('assertSendableBalance refuses when confirmed + credit are still short', async () => {
    mockConfirmed(100)
    unconfirmedChangeSats.mockResolvedValue(50)
    const { assertSendableBalance } = await import('./spendGuard')
    await expect(assertSendableBalance(500)).rejects.toThrow(/Insufficient balance/)
  })

  it('never spends against an unreadable balance as if the wallet were empty', async () => {
    // Under heavy IndexedDB contention every spendable read can fail at once.
    // Treating that as 0 reported a funded wallet as broke.
    fetchBalanceRead.mockResolvedValue({
      kind: 'unavailable',
      reason: 'storageUnreadable',
    })
    const { assertSendableBalance, refreshSpendableBalance } = await import('./spendGuard')

    await expect(assertSendableBalance(500)).rejects.toThrow(/could not be read/)
    await expect(refreshSpendableBalance()).rejects.toThrow(/could not be read/)
    // No "insufficient" verdict may be reached from a failed read.
    await expect(assertSendableBalance(500)).rejects.not.toThrow(/Insufficient balance/)
    expect(unconfirmedChangeSats).not.toHaveBeenCalled()
  })
})
