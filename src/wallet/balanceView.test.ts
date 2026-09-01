import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetActiveWallet = vi.fn()

vi.mock('./session', () => ({
  getActiveWallet: () => mockGetActiveWallet(),
}))

const { classifyOwnedCash, txLivenessFromStatus, unconfirmedChangeSats } =
  await import('./balanceView')

describe('txLivenessFromStatus', () => {
  it('separates pending sends from settled transactions', () => {
    for (const status of ['sending', 'unproven', 'nosend', 'nonfinal']) {
      expect(txLivenessFromStatus(status)).toBe('pending')
    }
    expect(txLivenessFromStatus('completed')).toBe('settled')
  })

  it('treats failed / missing as not live', () => {
    expect(txLivenessFromStatus('failed')).toBe('dead')
    expect(txLivenessFromStatus(undefined)).toBe('none')
  })
})

const sampleScript = '76a914000000000000000000000000000000000000000088ac'

describe('classifyOwnedCash', () => {
  it('counts remaining spendable coins', () => {
    expect(
      classifyOwnedCash({ satoshis: 40_000, spendable: true }, 'pending', 'none'),
    ).toEqual({ kind: 'count', as: 'spendable', satoshis: 40_000 })
  })

  it('credits unconfirmed change of a live send, even when not yet spendable', () => {
    expect(
      classifyOwnedCash(
        {
          satoshis: 9_000,
          change: true,
          spendable: false,
          lockingScript: sampleScript,
        },
        'pending',
        'none',
      ),
    ).toEqual({ kind: 'count', as: 'unconfirmedChange', satoshis: 9_000 })
  })

  it('does not credit script-less change rows', () => {
    expect(
      classifyOwnedCash(
        { satoshis: 9_000, change: true, spendable: false },
        'pending',
        'none',
      ),
    ).toEqual({ kind: 'exclude', reason: 'notOurs' })
  })

  it('drops inputs of a live send so the displayed total is not send+change', () => {
    expect(
      classifyOwnedCash(
        { satoshis: 50_000, spendable: false, spentBy: 7 },
        'pending',
        'pending',
      ),
    ).toEqual({ kind: 'exclude', reason: 'spentLive' })
  })

  it('does not count the payment output going to someone else', () => {
    expect(
      classifyOwnedCash(
        { satoshis: 1_000, change: false, spendable: false },
        'pending',
        'none',
      ),
    ).toEqual({ kind: 'exclude', reason: 'notOurs' })
  })

  it('keeps items and tokens out of Pay', () => {
    expect(
      classifyOwnedCash(
        { satoshis: 1, spendable: true, basket: '1sat' },
        'pending',
        'none',
      ),
    ).toEqual({ kind: 'exclude', reason: 'item' })
    expect(
      classifyOwnedCash(
        { satoshis: 100, spendable: true, basket: 'bsv21' },
        'pending',
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

  it('does not credit historical change from a completed transaction', () => {
    expect(
      classifyOwnedCash(
        { satoshis: 9_000, change: true, spendable: false },
        'settled',
        'none',
      ),
    ).toEqual({ kind: 'exclude', reason: 'notOurs' })
  })

  it('still excludes an input spent by a completed transaction', () => {
    expect(
      classifyOwnedCash(
        { satoshis: 50_000, spendable: false, spentBy: 7 },
        'none',
        'settled',
      ),
    ).toEqual({ kind: 'exclude', reason: 'spentLive' })
  })
})

describe('owned cash while sending', () => {
  it('equals leftover spendable plus in-flight change, not inputs minus nothing', () => {
    const input = classifyOwnedCash(
      { satoshis: 50_000, spendable: false, spentBy: 1 },
      'pending',
      'pending',
    )
    const payment = classifyOwnedCash(
      { satoshis: 1_000, change: false, spendable: false },
      'pending',
      'none',
    )
    const change = classifyOwnedCash(
      {
        satoshis: 48_990,
        change: true,
        spendable: false,
        lockingScript: sampleScript,
      },
      'pending',
      'none',
    )
    const leftover = classifyOwnedCash(
      { satoshis: 10_000, spendable: true },
      'pending',
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
      {
        satoshis: 9_000,
        change: true,
        spendable: false,
        transactionId: 9,
        lockingScript: sampleScript,
      },
    ])
    findTransactions.mockResolvedValue([{ status: 'unproven' }])

    await expect(unconfirmedChangeSats()).resolves.toBe(9_000)
    expect(findOutputs).toHaveBeenCalledWith({
      partial: { spendable: false, change: true },
      paged: { limit: 200, offset: 0 },
    })
  })

  it('does not re-credit completed change restored from BRC-39 history', async () => {
    findOutputs.mockResolvedValue([
      {
        satoshis: 9_000,
        change: true,
        spendable: false,
        transactionId: 9,
        lockingScript: sampleScript,
      },
    ])
    findTransactions.mockResolvedValue([{ status: 'completed' }])

    await expect(unconfirmedChangeSats()).resolves.toBe(0)
  })

  it('skips unspendable inputs that are not change', async () => {
    findOutputs.mockResolvedValue([
      { satoshis: 50_000, change: false, spendable: false, transactionId: 9 },
    ])
    findTransactions.mockResolvedValue([{ status: 'completed' }])

    await expect(unconfirmedChangeSats()).resolves.toBe(0)
    expect(findTransactions).not.toHaveBeenCalled()
  })

  it('resolves outputs and tx livenesses in one storage session', async () => {
    findOutputs.mockImplementation(async (args: { paged: { offset: number } }) =>
      args.paged.offset > 0
        ? []
        : [
            {
              satoshis: 1_000,
              change: true,
              spendable: false,
              transactionId: 1,
              spentBy: 11,
              lockingScript: sampleScript,
            },
            {
              satoshis: 2_000,
              change: true,
              spendable: false,
              transactionId: 2,
              spentBy: 12,
              lockingScript: sampleScript,
            },
            {
              satoshis: 3_000,
              change: true,
              spendable: false,
              transactionId: 3,
              spentBy: 13,
              lockingScript: sampleScript,
            },
          ],
    )
    findTransactions.mockImplementation(
      async (args: { partial: { transactionId: number } }) =>
        args.partial.transactionId > 10 ? [{ status: 'failed' }] : [{ status: 'unproven' }],
    )

    await expect(unconfirmedChangeSats()).resolves.toBe(6_000)

    // One session for the whole scan — pages and liveness share it.
    expect(runAsStorageProvider).toHaveBeenCalledTimes(1)
    expect(findTransactions).toHaveBeenCalledTimes(6)
  })

  it('asks once per distinct tx id across pages', async () => {
    findOutputs.mockImplementation(async (args: { paged: { offset: number } }) =>
      args.paged.offset > 0
        ? []
        : [
            {
              satoshis: 1_000,
              change: true,
              spendable: false,
              transactionId: 4,
              lockingScript: sampleScript,
            },
            {
              satoshis: 2_000,
              change: true,
              spendable: false,
              transactionId: 4,
              lockingScript: sampleScript,
            },
          ],
    )
    findTransactions.mockResolvedValue([{ status: 'unproven' }])

    await expect(unconfirmedChangeSats()).resolves.toBe(3_000)
    expect(findTransactions).toHaveBeenCalledTimes(1)
  })

  it('does not credit change when the liveness lookup fails', async () => {
    findOutputs.mockImplementation(async (args: { paged: { offset: number } }) =>
      args.paged.offset > 0
        ? []
        : [{ satoshis: 9_000, change: true, spendable: false, transactionId: 5, lockingScript: sampleScript }],
    )
    findTransactions.mockRejectedValue(new Error('idb closed'))

    await expect(unconfirmedChangeSats()).resolves.toBe(0)
  })

  it('stops once needAtLeast is covered instead of scanning the whole graveyard', async () => {
    findOutputs.mockImplementation(async (args: { paged: { offset: number } }) => {
      if (args.paged.offset === 0) {
        return [
          {
            satoshis: 4_000,
            change: true,
            spendable: false,
            transactionId: 1,
            lockingScript: sampleScript,
          },
          {
            satoshis: 5_000,
            change: true,
            spendable: false,
            transactionId: 2,
            lockingScript: sampleScript,
          },
        ]
      }
      return [
        {
          satoshis: 50_000,
          change: true,
          spendable: false,
          transactionId: 3,
          lockingScript: sampleScript,
        },
      ]
    })
    findTransactions.mockResolvedValue([{ status: 'unproven' }])

    await expect(unconfirmedChangeSats({ needAtLeast: 4_000 })).resolves.toBe(4_000)
    // First row already covers the shortfall — never ask for page 1 or tx 2/3.
    expect(findOutputs).toHaveBeenCalledTimes(1)
    expect(findTransactions).toHaveBeenCalledTimes(1)
  })
})
