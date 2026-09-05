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
const restoreLiveSpendableOutputs = vi.fn(async () => ({ restored: 0, unscripted: 0 }))
const reclaimSealedInputsNeverSpent = vi.fn(async () => 0)
const promotePendingLocalChangeOutputs = vi.fn(async () => 0)
const sweepChangeScripts = vi.fn(async () => ({
  scanned: 0,
  healed: 0,
  quarantined: 0,
  refused: 0,
}))

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
  bumpBalanceAfterHeal: vi.fn(),
}))

vi.mock('./balanceView', () => ({
  unconfirmedChangeSats: (opts?: { needAtLeast?: number }) => unconfirmedChangeSats(opts),
}))

vi.mock('./changeScriptFate', () => ({
  sweepChangeScripts: (opts?: { fromChain?: boolean }) => sweepChangeScripts(opts),
}))

vi.mock('./staleOutputRelease', () => ({
  restoreLiveSpendableOutputs: (opts?: { forSpendChain?: boolean }) =>
    restoreLiveSpendableOutputs(opts),
  reclaimSealedInputsNeverSpent: (opts?: { forSpendChain?: boolean }) =>
    reclaimSealedInputsNeverSpent(opts),
  promotePendingLocalChangeOutputs: (opts?: { forSpendChain?: boolean }) =>
    promotePendingLocalChangeOutputs(opts),
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
    restoreLiveSpendableOutputs.mockResolvedValue({ restored: 0, unscripted: 0 })
    reclaimSealedInputsNeverSpent.mockResolvedValue(0)
    promotePendingLocalChangeOutputs.mockResolvedValue(0)
    sweepChangeScripts.mockResolvedValue({
      scanned: 0,
      healed: 0,
      quarantined: 0,
      refused: 0,
    })
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

  it('assertSendableBalance credits unconfirmed change only for the shortfall', async () => {
    mockConfirmed(100)
    unconfirmedChangeSats.mockResolvedValue(900)
    restoreLiveSpendableOutputs.mockImplementation(async () => {
      mockConfirmed(600)
      return { restored: 1, unscripted: 0 }
    })
    const { assertSendableBalance } = await import('./spendGuard')
    await expect(assertSendableBalance(500)).resolves.toBe(600)
    expect(restoreLiveSpendableOutputs).toHaveBeenCalledWith({ forSpendChain: true })
    expect(unconfirmedChangeSats).not.toHaveBeenCalled()
  })

  it('assertSendableBalance retries pending-tx promotion inside runExclusiveSpend', async () => {
    mockConfirmed(2)
    unconfirmedChangeSats.mockResolvedValue(2614)
    promotePendingLocalChangeOutputs.mockImplementation(async () => {
      mockConfirmed(2616)
      return 1
    })
    restoreLiveSpendableOutputs.mockResolvedValue({ restored: 0, unscripted: 0 })

    const { runExclusiveSpend, assertSendableBalance } = await import('./spendGuard')
    await expect(
      runExclusiveSpend(() => assertSendableBalance(50)),
    ).resolves.toBe(2616)
    expect(promotePendingLocalChangeOutputs).toHaveBeenCalledWith({ forSpendChain: true })
  })

  it('assertSendableBalanceForReview does not promote change', async () => {
    mockConfirmed(100)
    const { assertSendableBalanceForReview } = await import('./spendGuard')
    await expect(assertSendableBalanceForReview(50)).resolves.toBe(100)
    expect(restoreLiveSpendableOutputs).not.toHaveBeenCalled()
    expect(reclaimSealedInputsNeverSpent).not.toHaveBeenCalled()
    expect(promotePendingLocalChangeOutputs).not.toHaveBeenCalled()
  })

  it('assertSendableBalanceForReview explains pending change without healing', async () => {
    mockConfirmed(2)
    unconfirmedChangeSats.mockResolvedValue(162_767)
    const { assertSendableBalanceForReview } = await import('./spendGuard')
    await expect(assertSendableBalanceForReview(50_000)).rejects.toThrow(/chains unconfirmed change/)
    expect(restoreLiveSpendableOutputs).not.toHaveBeenCalled()
  })

  it('assertSendableBalance force-promotes again when confirming covers the gap', async () => {
    mockConfirmed(2)
    unconfirmedChangeSats.mockResolvedValue(162_767)
    let promotePasses = 0
    promotePendingLocalChangeOutputs.mockImplementation(async () => {
      promotePasses += 1
      if (promotePasses >= 2) {
        mockConfirmed(50_000)
        return 1
      }
      return 0
    })
    restoreLiveSpendableOutputs.mockResolvedValue({ restored: 0, unscripted: 0 })
    const { assertSendableBalance } = await import('./spendGuard')
    await expect(assertSendableBalance(50_000)).resolves.toBe(50_000)
    expect(promotePendingLocalChangeOutputs.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('assertSendableBalance throws ChangeChainingRequiredError when promote cannot cover', async () => {
    mockConfirmed(2)
    unconfirmedChangeSats.mockResolvedValue(162_767)
    restoreLiveSpendableOutputs.mockResolvedValue({ restored: 0, unscripted: 0 })
    const { assertSendableBalance, isChangeChainingRequiredError } = await import('./spendGuard')
    await expect(assertSendableBalance(50_000)).rejects.toSatisfy(
      (err: unknown) =>
        isChangeChainingRequiredError(err) &&
        /chains unconfirmed change/.test(err instanceof Error ? err.message : ''),
    )
  })

  it('prepareBrcActionSpend adds a fee buffer to the gate', async () => {
    mockConfirmed(1500)
    const { prepareBrcActionSpend, BRC_ACTION_FEE_BUFFER_SATS } = await import('./spendGuard')
    // Payment 600 + buffer 1000 = 1600 > 1500 → refuse
    await expect(
      prepareBrcActionSpend('createAction', {
        outputs: [{ satoshis: 600, lockingScript: '00' }],
      }),
    ).rejects.toThrow(/Insufficient balance/)
    expect(BRC_ACTION_FEE_BUFFER_SATS).toBe(1000)
  })

  it('assertSendableBalance refuses when credit exists but change was not promoted', async () => {
    mockConfirmed(2)
    unconfirmedChangeSats.mockResolvedValue(162_767)
    restoreLiveSpendableOutputs.mockResolvedValue({ restored: 0, unscripted: 0 })
    const { assertSendableBalance } = await import('./spendGuard')
    await expect(assertSendableBalance(50_000)).rejects.toThrow(/chains unconfirmed change/)
    expect(unconfirmedChangeSats).toHaveBeenCalled()
  })

  it('assertSendableBalance skips restore and credit when confirmed covers the payment', async () => {
    mockConfirmed(10_000)
    const { assertSendableBalance } = await import('./spendGuard')
    await expect(assertSendableBalance(500)).resolves.toBe(10_000)
    expect(restoreLiveSpendableOutputs).not.toHaveBeenCalled()
    expect(unconfirmedChangeSats).not.toHaveBeenCalled()
  })

  it('assertSendableBalance stops after restore when confirmed becomes enough', async () => {
    mockConfirmed(100)
    restoreLiveSpendableOutputs.mockImplementation(async () => {
      mockConfirmed(600)
      return { restored: 1, unscripted: 0 }
    })
    const { assertSendableBalance } = await import('./spendGuard')
    await expect(assertSendableBalance(500)).resolves.toBe(600)
    expect(restoreLiveSpendableOutputs).toHaveBeenCalledWith({ forSpendChain: true })
    expect(unconfirmedChangeSats).not.toHaveBeenCalled()
  })

  it('assertSendableBalance refuses when confirmed + credit are still short', async () => {
    mockConfirmed(100)
    unconfirmedChangeSats.mockResolvedValue(50)
    const { assertSendableBalance } = await import('./spendGuard')
    await expect(assertSendableBalance(500)).rejects.toThrow(/Insufficient balance/)
  })

  it('runExclusiveSpend promotes local change without chain script sweep', async () => {
    const { runExclusiveSpend } = await import('./spendGuard')
    await expect(runExclusiveSpend(async () => 'ok')).resolves.toBe('ok')
    expect(sweepChangeScripts).toHaveBeenCalledWith({ fromChain: false })
    expect(sweepChangeScripts).not.toHaveBeenCalledWith({ fromChain: true })
    expect(promotePendingLocalChangeOutputs).toHaveBeenCalledWith({ forSpendChain: true })
  })

  it('runExclusiveSpend light promote skips the unscripted script sweep', async () => {
    const { runExclusiveSpend } = await import('./spendGuard')
    await expect(
      runExclusiveSpend(async () => 'ok', undefined, { promote: 'light' }),
    ).resolves.toBe('ok')
    expect(sweepChangeScripts).not.toHaveBeenCalled()
    expect(promotePendingLocalChangeOutputs).toHaveBeenCalledWith({ forSpendChain: true })
  })

  it('assertSendableBalance refuses chaining credit without running chain heal', async () => {
    mockConfirmed(100)
    unconfirmedChangeSats.mockResolvedValue(500)
    restoreLiveSpendableOutputs.mockResolvedValue({ restored: 0, unscripted: 0 })
    const { assertSendableBalance } = await import('./spendGuard')
    await expect(assertSendableBalance(500)).rejects.toThrow(/chains unconfirmed change/)
    expect(sweepChangeScripts).not.toHaveBeenCalledWith({ fromChain: true })
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
