import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetActiveWallet = vi.fn()

vi.mock('./session', () => ({
  getActiveWallet: () => mockGetActiveWallet(),
}))

const { classifyOwnedCash, txLivenessFromStatus, unconfirmedChangeSats } =
  await import('./balanceView')

describe('txLivenessFromStatus', () => {
  it('treats sending / unproven / completed as live', () => {
    for (const status of ['sending', 'unproven', 'completed', 'nosend', 'nonfinal']) {
      expect(txLivenessFromStatus(status)).toBe('live')
    }
  })

  it('treats failed / missing as not live', () => {
    expect(txLivenessFromStatus('failed')).toBe('dead')
    expect(txLivenessFromStatus(undefined)).toBe('none')
  })
})

describe('classifyOwnedCash', () => {
  it('counts remaining spendable coins', () => {
    expect(
      classifyOwnedCash({ satoshis: 40_000, spendable: true }, 'live', 'none'),
    ).toEqual({ kind: 'count', as: 'spendable', satoshis: 40_000 })
  })

  it('credits unconfirmed change of a live send, even when not yet spendable', () => {
    expect(
      classifyOwnedCash(
        { satoshis: 9_000, change: true, spendable: false },
        'live',
        'none',
      ),
    ).toEqual({ kind: 'count', as: 'unconfirmedChange', satoshis: 9_000 })
  })

  it('drops inputs of a live send so the displayed total is not send+change', () => {
    expect(
      classifyOwnedCash(
        { satoshis: 50_000, spendable: false, spentBy: 7 },
        'live',
        'live',
      ),
    ).toEqual({ kind: 'exclude', reason: 'spentLive' })
  })

  it('does not count the payment output going to someone else', () => {
    expect(
      classifyOwnedCash(
        { satoshis: 1_000, change: false, spendable: false },
        'live',
        'none',
      ),
    ).toEqual({ kind: 'exclude', reason: 'notOurs' })
  })

  it('keeps items and tokens out of Pay', () => {
    expect(
      classifyOwnedCash(
        { satoshis: 1, spendable: true, basket: '1sat' },
        'live',
        'none',
      ),
    ).toEqual({ kind: 'exclude', reason: 'item' })
    expect(
      classifyOwnedCash(
        { satoshis: 100, spendable: true, basket: 'bsv21' },
        'live',
        'none',
      ),
    ).toEqual({ kind: 'exclude', reason: 'bsv21' })
  })

  it('does not credit written-off change of a failed send', () => {
    expect(
      classifyOwnedCash(
        { satoshis: 9_000, change: true, spendable: false },
        'dead',
        'none',
      ),
    ).toEqual({ kind: 'exclude', reason: 'notOurs' })
  })
})

describe('owned cash while sending', () => {
  it('equals leftover spendable plus in-flight change, not inputs minus nothing', () => {
    const input = classifyOwnedCash(
      { satoshis: 50_000, spendable: false, spentBy: 1 },
      'live',
      'live',
    )
    const payment = classifyOwnedCash(
      { satoshis: 1_000, change: false, spendable: false },
      'live',
      'none',
    )
    const change = classifyOwnedCash(
      { satoshis: 48_990, change: true, spendable: false },
      'live',
      'none',
    )
    const leftover = classifyOwnedCash(
      { satoshis: 10_000, spendable: true },
      'live',
      'none',
    )
    const coins = [input, payment, change, leftover]
    const owned = coins.reduce(
      (n, fate) => (fate.kind === 'count' ? n + fate.satoshis : n),
      0,
    )
    expect(owned).toBe(58_990)
  })
})

describe('unconfirmedChangeSats', () => {
  const findOutputs = vi.fn()
  const findTransactions = vi.fn()
  const runAsStorageProvider = vi.fn(
    async (
      fn: (sp: {
        findOutputs: typeof findOutputs
        findTransactions: typeof findTransactions
      }) => Promise<unknown>,
    ) => fn({ findOutputs, findTransactions }),
  )

  beforeEach(() => {
    findOutputs.mockReset()
    findTransactions.mockReset()
    runAsStorageProvider.mockClear()
    mockGetActiveWallet.mockReset()
    mockGetActiveWallet.mockReturnValue({
      wallet: { storage: { runAsStorageProvider } },
    })
  })

  it('credits change of a live send without paging the spent graveyard', async () => {
    findOutputs.mockResolvedValue([
      { satoshis: 9_000, change: true, spendable: false, transactionId: 9 },
    ])
    findTransactions.mockResolvedValue([{ status: 'unproven' }])

    await expect(unconfirmedChangeSats()).resolves.toBe(9_000)
    expect(findOutputs).toHaveBeenCalledWith({
      partial: { spendable: false, change: true },
      paged: { limit: 200, offset: 0 },
    })
  })

  it('skips unspendable inputs that are not change', async () => {
    findOutputs.mockResolvedValue([
      { satoshis: 50_000, change: false, spendable: false, transactionId: 9 },
    ])
    findTransactions.mockResolvedValue([{ status: 'completed' }])

    await expect(unconfirmedChangeSats()).resolves.toBe(0)
    expect(findTransactions).not.toHaveBeenCalled()
  })

  it('resolves a page of tx livenesses in one storage session, not two per row', async () => {
    findOutputs.mockImplementation(async (args: { paged: { offset: number } }) =>
      args.paged.offset > 0
        ? []
        : [
            { satoshis: 1_000, change: true, spendable: false, transactionId: 1, spentBy: 11 },
            { satoshis: 2_000, change: true, spendable: false, transactionId: 2, spentBy: 12 },
            { satoshis: 3_000, change: true, spendable: false, transactionId: 3, spentBy: 13 },
          ],
    )
    findTransactions.mockImplementation(
      async (args: { partial: { transactionId: number } }) =>
        args.partial.transactionId > 10 ? [{ status: 'failed' }] : [{ status: 'unproven' }],
    )

    await expect(unconfirmedChangeSats()).resolves.toBe(6_000)

    // One session for the page of outputs, one for all six tx ids it needs.
    expect(runAsStorageProvider).toHaveBeenCalledTimes(2)
    expect(findTransactions).toHaveBeenCalledTimes(6)
  })

  it('asks once per distinct tx id across pages', async () => {
    findOutputs.mockImplementation(async (args: { paged: { offset: number } }) =>
      args.paged.offset > 0
        ? []
        : [
            { satoshis: 1_000, change: true, spendable: false, transactionId: 4 },
            { satoshis: 2_000, change: true, spendable: false, transactionId: 4 },
          ],
    )
    findTransactions.mockResolvedValue([{ status: 'unproven' }])

    await expect(unconfirmedChangeSats()).resolves.toBe(3_000)
    expect(findTransactions).toHaveBeenCalledTimes(1)
  })

  it('does not credit change when the liveness batch fails', async () => {
    findOutputs.mockImplementation(async (args: { paged: { offset: number } }) =>
      args.paged.offset > 0
        ? []
        : [{ satoshis: 9_000, change: true, spendable: false, transactionId: 5 }],
    )
    findTransactions.mockRejectedValue(new Error('idb closed'))

    await expect(unconfirmedChangeSats()).resolves.toBe(0)
  })
})
