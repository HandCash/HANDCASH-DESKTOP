import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockReviewSpendableOutputs = vi.fn()
const mockGetActiveWallet = vi.fn()
const overlayStore = new Map<string, string>()

vi.mock('./session', () => ({
  getActiveWallet: () => mockGetActiveWallet(),
}))

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => overlayStore.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    overlayStore.set(key, value)
    return true
  },
}))

const {
  isAlreadySpentInputError,
  isNoLongerSpendableError,
  isLiveLocalTxStatus,
  releaseStaleSpendableOutputs,
  restoreLiveSpendableOutputs,
  keepChangeOfSignedTx,
  promotePendingLocalChangeOutputs,
  hideSpentOutpoints,
  rehideInputsOfLiveLocalTxs,
  sealSpentInputsOfSignedTx,
  releaseSealedInputsOfUnsentTx,
} = await import('./staleOutputRelease')

const { hideUtxo, getUtxoLock, __resetUtxoLocksForTests } = await import(
  './utxoLockManager'
)

describe('isAlreadySpentInputError', () => {
  it('accepts the rejections that prove an input is spent or gone', () => {
    for (const message of [
      'Missing inputs',
      'bad-txns-inputs-missingorspent',
      'txn-mempool-conflict',
      'input already spent',
      'double spend detected',
      'doubleSpend',
    ]) {
      expect(isAlreadySpentInputError(new Error(message))).toBe(true)
    }
  })

  it('rejects failures that say nothing about our outputs', () => {
    for (const message of [
      'fetch failed',
      'Wallet locked',
      'WALLET_BRIDGE_TIMEOUT',
      'Insufficient funds',
      'status=503',
      'input 09da14e3.1 is no longer spendable',
    ]) {
      expect(isAlreadySpentInputError(new Error(message))).toBe(false)
    }
  })
})

describe('isNoLongerSpendableError', () => {
  it('matches wallet-storage spendable false, not chain spent', () => {
    expect(
      isNoLongerSpendableError(
        new Error(
          'WERR_INVALID_OPERATION: input 09da14e3026e0435fcf8357fcef5fc3541ad5568eada24b19cb0be5cee57132f.1 is no longer spendable',
        ),
      ),
    ).toBe(true)
    expect(isNoLongerSpendableError(new Error('input already spent'))).toBe(false)
    expect(isNoLongerSpendableError(new Error('Insufficient funds'))).toBe(false)
  })
})

describe('releaseStaleSpendableOutputs', () => {
  beforeEach(() => {
    mockReviewSpendableOutputs.mockReset()
    mockGetActiveWallet.mockReset()
    mockGetActiveWallet.mockReturnValue({
      chain: 'main',
      wallet: { reviewSpendableOutputs: mockReviewSpendableOutputs },
    })
  })

  it('releases across every basket and reports the count', async () => {
    mockReviewSpendableOutputs.mockResolvedValue({
      totalOutputs: 2,
      outputs: [{ outpoint: 'aa.0' }, { outpoint: 'bb.1' }],
    })

    await expect(releaseStaleSpendableOutputs()).resolves.toBe(2)
    expect(mockReviewSpendableOutputs).toHaveBeenCalledWith(true, true)
  })

  it('falls back to the default basket when the all-basket filter is unsupported', async () => {
    mockReviewSpendableOutputs
      .mockRejectedValueOnce(
        new Error('The args.partial.basketId parameter must be not undefined.'),
      )
      .mockResolvedValueOnce({ totalOutputs: 1, outputs: [{ outpoint: 'aa.0' }] })

    await expect(releaseStaleSpendableOutputs()).resolves.toBe(1)
    expect(mockReviewSpendableOutputs).toHaveBeenNthCalledWith(2, false, true)
  })

  it('reports nothing released when the provider is down', async () => {
    mockReviewSpendableOutputs.mockRejectedValue(new Error('provider down'))

    await expect(releaseStaleSpendableOutputs()).resolves.toBe(0)
  })

  it('does nothing without an unlocked wallet', async () => {
    mockGetActiveWallet.mockReturnValue(null)

    await expect(releaseStaleSpendableOutputs()).resolves.toBe(0)
    expect(mockReviewSpendableOutputs).not.toHaveBeenCalled()
  })
})

describe('isLiveLocalTxStatus', () => {
  it('treats sending / unproven / completed as a committed local spend', () => {
    expect(isLiveLocalTxStatus('sending')).toBe(true)
    expect(isLiveLocalTxStatus('unproven')).toBe(true)
    expect(isLiveLocalTxStatus('completed')).toBe(true)
    expect(isLiveLocalTxStatus('failed')).toBe(false)
    expect(isLiveLocalTxStatus('unsigned')).toBe(false)
  })
})

describe('restoreLiveSpendableOutputs', () => {
  const findOutputs = vi.fn()
  const updateOutput = vi.fn()
  const isUtxo = vi.fn()
  const findTransactions = vi.fn()
  const getProvenOrRawTx = vi.fn()
  const runAsStorageProvider = vi.fn(
    async (
      fn: (sp: {
        updateOutput: typeof updateOutput
        findTransactions: typeof findTransactions
        getProvenOrRawTx: typeof getProvenOrRawTx
      }) => Promise<unknown>,
    ) => fn({ updateOutput, findTransactions, getProvenOrRawTx }),
  )

  beforeEach(() => {
    findOutputs.mockReset()
    updateOutput.mockReset()
    isUtxo.mockReset()
    findTransactions.mockReset()
    getProvenOrRawTx.mockReset()
    runAsStorageProvider.mockClear()
    findTransactions.mockResolvedValue([])
    overlayStore.clear()
    __resetUtxoLocksForTests()
    mockGetActiveWallet.mockReset()
    mockGetActiveWallet.mockReturnValue({
      chain: 'main',
      services: { isUtxo },
      wallet: { storage: { findOutputs, runAsStorageProvider } },
    })
  })

  it('does not resurrect outputs just because the indexer still lists them', async () => {
    findOutputs.mockResolvedValue([
      { outputId: 1, spendable: false, lockingScript: [118, 169] },
      { outputId: 2, spendable: false, lockingScript: [118, 169] },
    ])
    isUtxo.mockResolvedValue(true)

    await expect(restoreLiveSpendableOutputs()).resolves.toBe(0)
    expect(updateOutput).not.toHaveBeenCalled()
    expect(isUtxo).not.toHaveBeenCalled()
  })

  it('does not resurrect an input spent by a local sending/unproven tx', async () => {
    findOutputs.mockResolvedValue([
      { outputId: 1, spendable: false, spentBy: 9, lockingScript: [118, 169] },
    ])
    findTransactions.mockResolvedValue([{ status: 'sending' }])
    isUtxo.mockResolvedValue(true)

    await expect(restoreLiveSpendableOutputs()).resolves.toBe(0)
    expect(updateOutput).not.toHaveBeenCalled()
    expect(isUtxo).not.toHaveBeenCalled()
  })

  it('restores change from a local unproven spend even when the indexer has not seen it', async () => {
    findOutputs.mockResolvedValue([
      {
        outputId: 2,
        transactionId: 9,
        change: true,
        spendable: false,
        lockingScript: [118, 169],
      },
    ])
    findTransactions.mockResolvedValue([{ status: 'unproven' }])
    isUtxo.mockResolvedValue(false)

    await expect(restoreLiveSpendableOutputs()).resolves.toBe(1)
    expect(updateOutput).toHaveBeenCalledWith(2, {
      spendable: true,
      spentBy: undefined,
    })
    expect(isUtxo).not.toHaveBeenCalled()
  })

  it('restores orphan BRC-39 change rows that lack creator tx status', async () => {
    findOutputs.mockResolvedValue([
      {
        outputId: 4,
        change: true,
        spendable: false,
        satoshis: 2614,
        lockingScript: [118, 169],
      },
    ])

    await expect(restoreLiveSpendableOutputs()).resolves.toBe(1)
    expect(updateOutput).toHaveBeenCalledWith(4, {
      spendable: true,
      spentBy: undefined,
    })
  })

  it('restores change from a locally completed spend left unspendable', async () => {
    findOutputs.mockResolvedValue([
      {
        outputId: 3,
        transactionId: 10,
        change: true,
        spendable: false,
        lockingScript: [118, 169],
      },
    ])
    findTransactions.mockResolvedValue([{ status: 'completed' }])

    await expect(restoreLiveSpendableOutputs()).resolves.toBe(1)
    expect(updateOutput).toHaveBeenCalledWith(3, {
      spendable: true,
      spentBy: undefined,
    })
  })

  it('skips rows with no locking script instead of asking isUtxo', async () => {
    findOutputs.mockResolvedValue([{ outputId: 1, spendable: false }])

    await expect(restoreLiveSpendableOutputs()).resolves.toBe(0)
    expect(isUtxo).not.toHaveBeenCalled()
    expect(updateOutput).not.toHaveBeenCalled()
  })

  it('does not restore overlay-spent coins even when the indexer still lists them', async () => {
    const txid = 'ab'.repeat(32)
    findOutputs.mockResolvedValue([
      {
        outputId: 1,
        txid,
        vout: 0,
        spendable: false,
        lockingScript: [118, 169],
      },
    ])
    isUtxo.mockResolvedValue(true)
    hideUtxo(`${txid}.0`, { spentBy: '' })

    await expect(restoreLiveSpendableOutputs()).resolves.toBe(0)
    expect(updateOutput).not.toHaveBeenCalled()
    expect(isUtxo).not.toHaveBeenCalled()
  })

  it('after already-spent restores only live local change, not indexer UTXOs', async () => {
    findOutputs.mockResolvedValue([
      { outputId: 1, spendable: false, lockingScript: [118, 169] },
    ])
    isUtxo.mockResolvedValue(true)

    await expect(restoreLiveSpendableOutputs({ onlyLiveChange: true })).resolves.toBe(0)
    expect(updateOutput).not.toHaveBeenCalled()
  })

  it('sweeps a large unspendable set in one storage session', async () => {
    findOutputs.mockResolvedValue(
      Array.from({ length: 60 }, (_, i) => ({
        outputId: i + 1,
        transactionId: 9,
        change: true,
        spendable: false,
        lockingScript: [118, 169],
      })),
    )
    findTransactions.mockResolvedValue([{ status: 'unproven' }])

    await expect(restoreLiveSpendableOutputs()).resolves.toBe(60)
    // Re-entering the provider per row is what made this seconds long on a phone.
    expect(runAsStorageProvider).toHaveBeenCalledTimes(1)
  })

  it('does nothing without an unlocked wallet', async () => {
    mockGetActiveWallet.mockReturnValue(null)
    await expect(restoreLiveSpendableOutputs()).resolves.toBe(0)
  })
})

describe('keepChangeOfSignedTx', () => {
  const findOutputs = vi.fn()
  const updateOutput = vi.fn()

  beforeEach(() => {
    findOutputs.mockReset()
    updateOutput.mockReset()
    overlayStore.clear()
    __resetUtxoLocksForTests()
    mockGetActiveWallet.mockReset()
    mockGetActiveWallet.mockReturnValue({
      chain: 'main',
      wallet: {
        storage: {
          findOutputs,
          runAsStorageProvider: async (
            fn: (sp: {
              updateOutput: typeof updateOutput
              findOutputs: typeof findOutputs
              getProvenOrRawTx: () => Promise<undefined>
            }) => Promise<unknown>,
          ) =>
            fn({
              updateOutput,
              findOutputs,
              getProvenOrRawTx: async () => undefined,
            }),
        },
      },
    })
  })

  it('makes this tx change spendable without deleting the row', async () => {
    const txid = 'cd'.repeat(32)
    findOutputs.mockResolvedValue([
      {
        outputId: 9,
        txid,
        vout: 1,
        change: true,
        satoshis: 5000,
        spendable: false,
        lockingScript: [118, 169],
      },
    ])

    await expect(keepChangeOfSignedTx(txid)).resolves.toBe(1)
    expect(updateOutput).toHaveBeenCalledWith(9, {
      spendable: true,
      spentBy: undefined,
    })
  })
})

describe('promotePendingLocalChangeOutputs', () => {
  const findTransactions = vi.fn()
  const findOutputs = vi.fn()
  const updateOutput = vi.fn()

  beforeEach(() => {
    findTransactions.mockReset()
    findOutputs.mockReset()
    updateOutput.mockReset()
    overlayStore.clear()
    __resetUtxoLocksForTests()
    mockGetActiveWallet.mockReset()
    mockGetActiveWallet.mockReturnValue({
      chain: 'main',
      address: '1abc',
      wallet: {
        storage: {
          findTransactions,
          findOutputs,
          runAsStorageProvider: async (
            fn: (sp: {
              updateOutput: typeof updateOutput
              findOutputs: typeof findOutputs
              findTransactions: typeof findTransactions
              getProvenOrRawTx: () => Promise<undefined>
            }) => Promise<unknown>,
          ) =>
            fn({
              updateOutput,
              findOutputs,
              findTransactions,
              getProvenOrRawTx: async () => undefined,
            }),
        },
      },
    })
  })

  it('promotes change from live pending txs without paging unspendable rows', async () => {
    const txid = 'ef'.repeat(32)
    findTransactions.mockImplementation(async (args: { status?: string[] }) => {
      if (args.status?.includes('unproven')) {
        return [{ txid, status: 'unproven' }]
      }
      return []
    })
    findOutputs.mockResolvedValue([
      {
        outputId: 3,
        txid,
        vout: 1,
        change: true,
        satoshis: 8822,
        lockingScript: [0x76, 0xa9],
        spendable: false,
        spentBy: undefined,
      },
    ])

    await expect(promotePendingLocalChangeOutputs()).resolves.toBe(1)
    expect(updateOutput).toHaveBeenCalledWith(
      3,
      expect.objectContaining({ spendable: true }),
    )
  })
})

describe('hideSpentOutpoints', () => {
  const findOutputs = vi.fn()
  const updateOutput = vi.fn()

  beforeEach(() => {
    findOutputs.mockReset()
    updateOutput.mockReset()
    overlayStore.clear()
    __resetUtxoLocksForTests()
    mockGetActiveWallet.mockReset()
    mockGetActiveWallet.mockReturnValue({
      chain: 'main',
      wallet: {
        storage: {
          findOutputs,
          runAsStorageProvider: async (
            fn: (sp: {
              updateOutput: typeof updateOutput
              findOutputs: typeof findOutputs
            }) => Promise<unknown>,
          ) => fn({ updateOutput, findOutputs }),
        },
      },
    })
  })

  it('marks toolbox rows unspendable and overlays them as spent', async () => {
    const txid = 'ee'.repeat(32)
    findOutputs.mockResolvedValue([
      { outputId: 3, txid, vout: 1, satoshis: 100, spendable: true },
    ])

    await expect(hideSpentOutpoints([`${txid}.1`])).resolves.toBe(1)
    expect(updateOutput).toHaveBeenCalledWith(3, { spendable: false })
  })
})

describe('rehideInputsOfLiveLocalTxs', () => {
  const findOutputs = vi.fn()
  const updateOutput = vi.fn()
  const findTransactions = vi.fn()

  beforeEach(() => {
    findOutputs.mockReset()
    updateOutput.mockReset()
    findTransactions.mockReset()
    overlayStore.clear()
    __resetUtxoLocksForTests()
    mockGetActiveWallet.mockReset()
    mockGetActiveWallet.mockReturnValue({
      chain: 'main',
      wallet: {
        storage: {
          findOutputs,
          runAsStorageProvider: async (
            fn: (sp: {
              updateOutput: typeof updateOutput
              findOutputs: typeof findOutputs
              findTransactions: typeof findTransactions
            }) => Promise<unknown>,
          ) => fn({ updateOutput, findOutputs, findTransactions }),
        },
      },
    })
  })

  it('marks inputs of a completed local spend unspendable again', async () => {
    const { P2PKH, PrivateKey, Transaction, UnlockingScript } = await import('@bsv/sdk')
    const prevTxid = '11'.repeat(32)
    const tx = new Transaction()
    tx.addInput({
      sourceTXID: prevTxid,
      sourceOutputIndex: 1,
      unlockingScript: new UnlockingScript([]),
      sequence: 0xffffffff,
    })
    tx.addOutput({
      satoshis: 1000,
      lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()),
    })
    findTransactions.mockResolvedValue([
      { status: 'completed', txid: '22'.repeat(32), rawTx: tx.toBinary() },
    ])
    findOutputs.mockResolvedValue([
      { outputId: 4, txid: prevTxid, vout: 1, satoshis: 5000, spendable: true },
    ])

    await expect(rehideInputsOfLiveLocalTxs()).resolves.toBe(1)
    expect(updateOutput).toHaveBeenCalledWith(4, { spendable: false })
  })
})

/**
 * Back-to-back sends: the rehide pass above defers while a spend is queued, so
 * the spend path has to retire its own inputs or the next createAction picks a
 * coin that is already gone and every broadcaster rejects the double spend.
 */
describe('sealSpentInputsOfSignedTx', () => {
  const findOutputs = vi.fn()
  const updateOutput = vi.fn()

  beforeEach(() => {
    findOutputs.mockReset()
    updateOutput.mockReset()
    overlayStore.clear()
    __resetUtxoLocksForTests()
    mockGetActiveWallet.mockReset()
    mockGetActiveWallet.mockReturnValue({
      chain: 'main',
      wallet: {
        storage: {
          findOutputs,
          runAsStorageProvider: async (
            fn: (sp: {
              updateOutput: typeof updateOutput
              findOutputs: typeof findOutputs
            }) => Promise<unknown>,
          ) => fn({ updateOutput, findOutputs }),
        },
      },
    })
  })

  async function signedTx(prevTxid: string, vout: number) {
    const { P2PKH, PrivateKey, Transaction, UnlockingScript } = await import('@bsv/sdk')
    const tx = new Transaction()
    tx.addInput({
      sourceTXID: prevTxid,
      sourceOutputIndex: vout,
      unlockingScript: new UnlockingScript([]),
      sequence: 0xffffffff,
    })
    tx.addOutput({
      satoshis: 1000,
      lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()),
    })
    return tx
  }

  it('hides the coin a signed spend consumed so the next send cannot reselect it', async () => {
    const prevTxid = '33'.repeat(32)
    const tx = await signedTx(prevTxid, 1)
    findOutputs.mockResolvedValue([
      { outputId: 7, txid: prevTxid, vout: 1, satoshis: 5000, spendable: true },
    ])

    await expect(
      sealSpentInputsOfSignedTx(tx.id('hex'), tx.toBinary()),
    ).resolves.toBe(1)
    expect(updateOutput).toHaveBeenCalledWith(7, { spendable: false })
  })

  it('does nothing without a usable txid', async () => {
    await expect(sealSpentInputsOfSignedTx(undefined, [1, 2, 3])).resolves.toBe(0)
    await expect(sealSpentInputsOfSignedTx('not-a-txid', [1, 2, 3])).resolves.toBe(0)
    expect(updateOutput).not.toHaveBeenCalled()
  })

  it('leaves the row alone when the transaction names no inputs', async () => {
    const { P2PKH, PrivateKey, Transaction } = await import('@bsv/sdk')
    const tx = new Transaction()
    tx.addOutput({
      satoshis: 1000,
      lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()),
    })

    await expect(
      sealSpentInputsOfSignedTx(tx.id('hex'), tx.toBinary()),
    ).resolves.toBe(0)
    expect(updateOutput).not.toHaveBeenCalled()
  })

  it('names the sealing transaction so the seal can be audited later', async () => {
    const prevTxid = '44'.repeat(32)
    const tx = await signedTx(prevTxid, 0)
    findOutputs.mockResolvedValue([
      { outputId: 8, txid: prevTxid, vout: 0, satoshis: 5000, spendable: true },
    ])

    await sealSpentInputsOfSignedTx(tx.id('hex'), tx.toBinary())

    expect(getUtxoLock(`${prevTxid}_0`)?.spentBy).toBe(tx.id('hex'))
  })

  it('gives the coin back when the spend never reached a node', async () => {
    const prevTxid = '55'.repeat(32)
    const tx = await signedTx(prevTxid, 0)
    findOutputs.mockResolvedValue([
      { outputId: 9, txid: prevTxid, vout: 0, satoshis: 5000, spendable: true },
    ])

    await sealSpentInputsOfSignedTx(tx.id('hex'), tx.toBinary())
    expect(getUtxoLock(`${prevTxid}_0`)?.spendable).toBe(false)

    await expect(
      releaseSealedInputsOfUnsentTx(tx.id('hex'), tx.toBinary()),
    ).resolves.toBe(1)

    const lock = getUtxoLock(`${prevTxid}_0`)
    expect(lock?.spendable).toBe(true)
    expect(lock?.spentBy).toBeNull()
    expect(updateOutput).toHaveBeenCalledWith(9, { spendable: true })
  })
})
