import { P2PKH, PrivateKey, Transaction } from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockReviewSpendableOutputs = vi.fn()
const mockGetActiveWallet = vi.fn()
const overlayStore = new Map<string, string>()

vi.mock('./session', () => ({
  getActiveWallet: () => mockGetActiveWallet(),
  bumpBalanceAfterHeal: vi.fn(),
}))

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => overlayStore.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    overlayStore.set(key, value)
    return true
  },
}))

const txExistsOnChain = vi.fn(async () => null as boolean | null)
const spentStatusOfOutpoint = vi.fn(async () => 'unknown' as const)

vi.mock('./legacyScan', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./legacyScan')>()
  return {
    ...actual,
    txExistsOnChain: (...a: unknown[]) => txExistsOnChain(...(a as [string, never])),
    spentStatusOfOutpoint: (...a: unknown[]) =>
      spentStatusOfOutpoint(...(a as [string, never])),
  }
})

const fetchRawTxHex = vi.fn(async () => null as string | null)
const peekRawTxLookup = vi.fn(() => 'unknown' as 'hit' | 'miss' | 'unknown')

// Stubbed whole, not spread from the original: `oneSatImport` imports this
// module back, so loading it inside the factory deadlocks the dynamic import.
vi.mock('./oneSatImport', () => ({
  fetchRawTxHex: (...a: unknown[]) => fetchRawTxHex(...(a as [])),
  peekRawTxLookup: (...a: unknown[]) => peekRawTxLookup(...(a as [])),
}))

const reimportDerivedChangeOutpoints = vi.fn(async () => ({
  imported: 0,
  skipped: 0,
  failed: 0,
}))
vi.mock('./reimportDerivedChange', () => ({
  reimportDerivedChangeOutpoints: (...args: unknown[]) =>
    reimportDerivedChangeOutpoints(...(args as [string[]])),
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
  failUnsentLocalTx,
  reclaimSealedInputsNeverSpent,
  reclaimOutputsSealedByDeadTxs,
  restoreOnChainLocalTx,
  restoreUnspentAssetOutpoint,
  chooseUtxoEvidenceAction,
  pinBroadcastLocalTx,
  healAppHeldChange,
  __resetReclaimSealCursorsForTests,
} = await import('./staleOutputRelease')
const sentItemGuard = await import('./sentItemGuard')

describe('chooseUtxoEvidenceAction', () => {
  it('quarantines a spent spendable output until a spender tx can be inserted', () => {
    expect(
      chooseUtxoEvidenceAction({
        verdict: 'spent',
        spendable: true,
        hasToolboxSpender: false,
        blockedByLocalSpend: false,
        itemTransferPending: false,
      }),
    ).toEqual({ action: 'quarantine', reason: 'spent-spender-unknown' })
    expect(
      chooseUtxoEvidenceAction({
        verdict: 'unknown',
        spendable: true,
        hasToolboxSpender: false,
        blockedByLocalSpend: false,
        itemTransferPending: false,
      }),
    ).toEqual({ action: 'keep', reason: 'unknown' })
  })

  it('adopts a named local spender instead of quarantining', () => {
    expect(
      chooseUtxoEvidenceAction({
        verdict: 'spent',
        spendable: true,
        hasToolboxSpender: true,
        blockedByLocalSpend: false,
        itemTransferPending: false,
      }),
    ).toEqual({ action: 'remove', reason: 'proven-spent' })
  })

  it('keeps a live local cheque instead of writing off the coin', () => {
    expect(
      chooseUtxoEvidenceAction({
        verdict: 'spent',
        spendable: true,
        hasToolboxSpender: false,
        blockedByLocalSpend: true,
        itemTransferPending: false,
      }),
    ).toEqual({ action: 'keep', reason: 'local-spend' })
  })

  it('restores only a proven-unspent dropped output with no local owner', () => {
    expect(
      chooseUtxoEvidenceAction({
        verdict: 'unspent',
        spendable: false,
        hasToolboxSpender: false,
        blockedByLocalSpend: false,
        itemTransferPending: false,
      }),
    ).toEqual({ action: 'restore', reason: 'proven-unspent-dropped' })
    expect(
      chooseUtxoEvidenceAction({
        verdict: 'unspent',
        spendable: false,
        hasToolboxSpender: false,
        blockedByLocalSpend: true,
        itemTransferPending: false,
      }),
    ).toEqual({ action: 'keep', reason: 'local-spend' })
  })
})

const { creditUtxo, hideUtxo, getUtxoLock, __resetUtxoLocksForTests } =
  await import('./utxoLockManager')
const {
  rememberArcadeSubmitContact,
  __resetArcadeSubmitGuardForTests,
} = await import('./arcadeSubmitGuard')

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

describe('restoreUnspentAssetOutpoint', () => {
  beforeEach(() => {
    overlayStore.clear()
    sentItemGuard.resetSentItemsForTests()
    __resetUtxoLocksForTests()
    spentStatusOfOutpoint.mockReset()
    spentStatusOfOutpoint.mockResolvedValue('unknown')
  })

  it('restores an asset row only after the wallet service proves it is unspent', async () => {
    const txid = 'ab'.repeat(32)
    const updateOutput = vi.fn(async () => undefined)
    hideUtxo(`${txid}.1`, { spentBy: 'cd'.repeat(32), satoshis: 1 })
    const active = {
      chain: 'main',
      services: {
        isUtxo: vi.fn(async () => ({ isUtxo: true })),
      },
      wallet: {
        storage: {
          runAsStorageProvider: async (fn: (sp: unknown) => Promise<void>) =>
            fn({
              findOutputs: async () => [
                { outputId: 7, txid, vout: 1, basket: 'bsv21' },
              ],
              updateOutput,
            }),
        },
      },
    }

    await expect(
      restoreUnspentAssetOutpoint(active as never, `${txid}.1`),
    ).resolves.toBe(true)
    expect(updateOutput).toHaveBeenCalledWith(7, {
      spendable: true,
      spentBy: undefined,
    })
    expect(getUtxoLock(`${txid}.1`)?.spendable).toBe(true)
  })

  it('does not restore an asset when live providers cannot prove it unspent', async () => {
    const txid = 'ef'.repeat(32)
    const updateOutput = vi.fn(async () => undefined)
    const active = {
      chain: 'main',
      services: { isUtxo: vi.fn(async () => false) },
      wallet: {
        storage: {
          runAsStorageProvider: async () => undefined,
        },
      },
    }

    await expect(
      restoreUnspentAssetOutpoint(active as never, `${txid}.0`),
    ).resolves.toBe(false)
    expect(updateOutput).not.toHaveBeenCalled()
  })

  it('rechecks a recent spend after an unspent lookup already started', async () => {
    const txid = '34'.repeat(32)
    let finishLookup!: () => void
    const lookup = new Promise<void>((resolve) => {
      finishLookup = resolve
    })
    const runAsStorageProvider = vi.fn(async () => undefined)
    const active = {
      chain: 'main',
      services: {
        isUtxo: vi.fn(async () => {
          await lookup
          return { isUtxo: true }
        }),
      },
      wallet: { storage: { runAsStorageProvider } },
    }

    const restoring = restoreUnspentAssetOutpoint(active as never, `${txid}.0`)
    sentItemGuard.markItemsSent([
      { outpoint: `${txid}.0`, txid: '56'.repeat(32) },
    ])
    finishLookup()

    await expect(restoring).resolves.toBe(false)
    expect(runAsStorageProvider).not.toHaveBeenCalled()
  })
})

describe('releaseStaleSpendableOutputs', () => {
  const txid = 'ab'.repeat(32)
  const updateOutput = vi.fn(async () => ({}))
  const findOutputs = vi.fn()
  const runAsStorageProvider = vi.fn(
    async (fn: (sp: { findOutputs: typeof findOutputs; updateOutput: typeof updateOutput }) => Promise<unknown>) =>
      fn({ findOutputs, updateOutput }),
  )

  beforeEach(() => {
    mockReviewSpendableOutputs.mockReset()
    mockGetActiveWallet.mockReset()
    findOutputs.mockReset()
    updateOutput.mockClear()
    runAsStorageProvider.mockClear()
    spentStatusOfOutpoint.mockReset()
    txExistsOnChain.mockReset()
    overlayStore.clear()
    mockGetActiveWallet.mockReturnValue({
      chain: 'main',
      services: { isUtxo: vi.fn(async () => false) },
      wallet: {
        storage: { runAsStorageProvider },
      },
    })
  })

  it('removes a spendable output only after affirmative spent evidence', async () => {
    findOutputs
      .mockResolvedValueOnce([
        {
          outputId: 7,
          txid,
          vout: 0,
          satoshis: 500,
          spendable: true,
          lockingScript: [81],
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          outputId: 7,
          txid,
          vout: 0,
          satoshis: 500,
          spendable: true,
          lockingScript: [81],
        },
      ])
    spentStatusOfOutpoint.mockResolvedValue('spent')

    await expect(releaseStaleSpendableOutputs()).resolves.toBe(1)
    expect(updateOutput).toHaveBeenCalledWith(7, { spendable: false })
  })

  it('keeps a spendable output when providers are inconclusive', async () => {
    findOutputs
      .mockResolvedValueOnce([
        {
          outputId: 8,
          txid,
          vout: 1,
          satoshis: 500,
          spendable: true,
          lockingScript: [81],
        },
      ])
      .mockResolvedValueOnce([])
    spentStatusOfOutpoint.mockResolvedValue('unknown')

    await expect(releaseStaleSpendableOutputs()).resolves.toBe(0)
    expect(updateOutput).not.toHaveBeenCalled()
  })

  it('does nothing without an unlocked wallet', async () => {
    mockGetActiveWallet.mockReturnValue(null)

    await expect(releaseStaleSpendableOutputs()).resolves.toBe(0)
    expect(runAsStorageProvider).not.toHaveBeenCalled()
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

  it('treats proof-pipeline statuses as live until completed', () => {
    for (const status of ['unmined', 'callback', 'unconfirmed', 'unknown']) {
      expect(isLiveLocalTxStatus(status)).toBe(true)
    }
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
    txExistsOnChain.mockReset()
    spentStatusOfOutpoint.mockReset()
    txExistsOnChain.mockResolvedValue(null)
    spentStatusOfOutpoint.mockResolvedValue('unknown')
    fetchRawTxHex.mockReset()
    fetchRawTxHex.mockResolvedValue(null)
    peekRawTxLookup.mockReset()
    peekRawTxLookup.mockReturnValue('unknown')
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

    await expect(restoreLiveSpendableOutputs()).resolves.toEqual({
      restored: 0,
      unscripted: 0,
    })
    expect(updateOutput).not.toHaveBeenCalled()
    expect(isUtxo).not.toHaveBeenCalled()
  })

  it('does not resurrect an input spent by a local sending/unproven tx', async () => {
    findOutputs.mockResolvedValue([
      { outputId: 1, spendable: false, spentBy: 9, lockingScript: [118, 169] },
    ])
    findTransactions.mockResolvedValue([{ status: 'sending' }])
    isUtxo.mockResolvedValue(true)

    await expect(restoreLiveSpendableOutputs()).resolves.toEqual({
      restored: 0,
      unscripted: 0,
    })
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

    await expect(restoreLiveSpendableOutputs()).resolves.toEqual({
      restored: 1,
      unscripted: 0,
    })
    expect(updateOutput).toHaveBeenCalledWith(2, {
      spendable: true,
      spentBy: undefined,
    })
    expect(isUtxo).not.toHaveBeenCalled()
  })

  it('restores orphan BRC-39 change rows proven unspent on chain', async () => {
    findOutputs.mockResolvedValue([
      {
        outputId: 4,
        txid: 'a'.repeat(64),
        outputIndex: 1,
        change: true,
        spendable: false,
        satoshis: 2614,
        lockingScript: [118, 169],
      },
    ])
    isUtxo.mockResolvedValue(true)

    await expect(restoreLiveSpendableOutputs()).resolves.toEqual({
      restored: 1,
      unscripted: 0,
    })
    expect(updateOutput).toHaveBeenCalledWith(4, {
      spendable: true,
      spentBy: undefined,
    })
  })

  it('restores change from a locally completed spend proven unspent on chain', async () => {
    findOutputs.mockResolvedValue([
      {
        outputId: 3,
        txid: 'b'.repeat(64),
        outputIndex: 1,
        transactionId: 10,
        change: true,
        spendable: false,
        lockingScript: [118, 169],
      },
    ])
    findTransactions.mockResolvedValue([{ status: 'completed' }])
    isUtxo.mockResolvedValue(false)
    spentStatusOfOutpoint.mockResolvedValue('unspent')

    await expect(restoreLiveSpendableOutputs()).resolves.toEqual({
      restored: 1,
      unscripted: 0,
    })
    expect(updateOutput).toHaveBeenCalledWith(3, {
      spendable: true,
      spentBy: undefined,
    })
  })

  // Regression: heal resurrected three coins the chain had spent ~200 blocks
  // earlier, the next createAction swept them in, ARC answered UTXO_SPENT, and
  // the doubleSpend mark took the honest change in that same tx down with it.
  it('refuses to restore a settled-creator coin already spent on chain', async () => {
    findOutputs.mockResolvedValue([
      {
        outputId: 5,
        txid: 'c'.repeat(64),
        outputIndex: 5,
        transactionId: 11,
        change: true,
        spendable: false,
        satoshis: 5000,
        lockingScript: [118, 169],
      },
    ])
    findTransactions.mockResolvedValue([{ status: 'completed' }])
    isUtxo.mockResolvedValue(false)
    spentStatusOfOutpoint.mockResolvedValue('spent')

    await expect(restoreLiveSpendableOutputs()).resolves.toEqual({
      restored: 0,
      unscripted: 0,
    })
    expect(updateOutput).not.toHaveBeenCalled()
  })

  it('refuses a settled-creator coin when no provider can prove it unspent', async () => {
    findOutputs.mockResolvedValue([
      {
        outputId: 6,
        txid: 'd'.repeat(64),
        outputIndex: 0,
        transactionId: 12,
        change: true,
        spendable: false,
        satoshis: 5000,
        lockingScript: [118, 169],
      },
    ])
    findTransactions.mockResolvedValue([{ status: 'completed' }])
    isUtxo.mockRejectedValue(new Error('offline'))
    spentStatusOfOutpoint.mockResolvedValue('unknown')

    await expect(restoreLiveSpendableOutputs()).resolves.toEqual({
      restored: 0,
      unscripted: 0,
    })
    expect(updateOutput).not.toHaveBeenCalled()
  })

  it('skips rows with no locking script instead of asking isUtxo', async () => {
    findOutputs.mockResolvedValue([{ outputId: 1, spendable: false }])

    await expect(restoreLiveSpendableOutputs()).resolves.toEqual({
      restored: 0,
      unscripted: 1,
    })
    expect(isUtxo).not.toHaveBeenCalled()
    expect(updateOutput).not.toHaveBeenCalled()
  })

  /**
   * hc-a580a: `sweep ... refused=118 noRawtx=118` then `unscripted-skipped`.
   * The sweep quarantines change whose raw tx the device never kept so
   * `allocateChangeInput` cannot crash on it, and restore then skipped exactly
   * those rows — so real, unspent coins left the spendable balance for good.
   */
  describe('change whose raw tx only the chain still has', () => {
    const address = PrivateKey.fromRandom().toPublicKey().toAddress('mainnet')
    const creator = new Transaction()
    creator.addOutput({ lockingScript: new P2PKH().lock(address), satoshis: 2614 })

    function quarantinedScriptlessChange() {
      findOutputs.mockResolvedValue([
        {
          outputId: 7,
          txid: creator.id('hex'),
          outputIndex: 0,
          transactionId: 21,
          change: true,
          spendable: false,
          satoshis: 2614,
        },
      ])
      findTransactions.mockResolvedValue([{ status: 'completed' }])
      isUtxo.mockResolvedValue(false)
      spentStatusOfOutpoint.mockResolvedValue('unspent')
    }

    it('writes the coin off when only local storage may be consulted', async () => {
      quarantinedScriptlessChange()

      await expect(restoreLiveSpendableOutputs()).resolves.toEqual({
        restored: 0,
        unscripted: 1,
      })
      expect(fetchRawTxHex).not.toHaveBeenCalled()
      expect(updateOutput).not.toHaveBeenCalled()
    })

    it('rebuilds the script from the chain on Refresh and restores the coin', async () => {
      quarantinedScriptlessChange()
      fetchRawTxHex.mockResolvedValue(creator.toHex())

      await expect(
        restoreLiveSpendableOutputs({ fromChain: true }),
      ).resolves.toEqual({ restored: 1, unscripted: 0 })
      expect(updateOutput).toHaveBeenCalledWith(7, {
        spendable: true,
        spentBy: undefined,
        lockingScript: creator.outputs[0].lockingScript.toBinary(),
      })
    })

    it('never takes a script from a transaction that pays a different amount', async () => {
      quarantinedScriptlessChange()
      const impostor = new Transaction()
      impostor.addOutput({
        lockingScript: new P2PKH().lock(address),
        satoshis: 9999,
      })
      fetchRawTxHex.mockResolvedValue(impostor.toHex())

      await expect(
        restoreLiveSpendableOutputs({ fromChain: true }),
      ).resolves.toEqual({ restored: 0, unscripted: 1 })
      expect(updateOutput).not.toHaveBeenCalled()
    })

    it('keeps the spend path local even when a caller asks for the chain', async () => {
      quarantinedScriptlessChange()
      fetchRawTxHex.mockResolvedValue(creator.toHex())

      await expect(
        restoreLiveSpendableOutputs({ fromChain: true, forSpendChain: true }),
      ).resolves.toEqual({ restored: 0, unscripted: 1 })
      expect(fetchRawTxHex).not.toHaveBeenCalled()
    })
  })

  it('does not restore blank-seal overlay coins the indexer still marks spent', async () => {
    const txid = 'ab'.repeat(32)
    findOutputs.mockResolvedValue([
      {
        outputId: 1,
        txid,
        vout: 0,
        change: true,
        satoshis: 5000,
        transactionId: 10,
        spendable: false,
        lockingScript: [118, 169],
      },
    ])
    findTransactions.mockResolvedValue([{ status: 'completed' }])
    isUtxo.mockResolvedValue(false)
    hideUtxo(`${txid}.0`, { spentBy: '' })

    await expect(restoreLiveSpendableOutputs()).resolves.toEqual({
      restored: 0,
      unscripted: 0,
    })
    expect(updateOutput).not.toHaveBeenCalled()
    expect(isUtxo).toHaveBeenCalled()
  })

  it('restores blank-seal overlay change still unspent after ghost hide', async () => {
    const txid = 'cd'.repeat(32)
    findOutputs.mockResolvedValue([
      {
        outputId: 2,
        txid,
        vout: 0,
        change: true,
        satoshis: 5000,
        transactionId: 11,
        spendable: false,
        lockingScript: [118, 169],
      },
    ])
    findTransactions.mockResolvedValue([{ status: 'completed' }])
    isUtxo.mockResolvedValue(true)
    hideUtxo(`${txid}.0`, { spentBy: '' })

    await expect(restoreLiveSpendableOutputs()).resolves.toEqual({
      restored: 1,
      unscripted: 0,
    })
    expect(updateOutput).toHaveBeenCalledWith(2, {
      spendable: true,
      spentBy: undefined,
    })
  })

  it('after already-spent restores only live local change, not indexer UTXOs', async () => {
    findOutputs.mockResolvedValue([
      { outputId: 1, spendable: false, lockingScript: [118, 169] },
    ])
    isUtxo.mockResolvedValue(true)

    await expect(restoreLiveSpendableOutputs({ onlyLiveChange: true })).resolves.toEqual({
      restored: 0,
      unscripted: 0,
    })
    expect(updateOutput).not.toHaveBeenCalled()
  })

  it('sweeps a large unspendable set in a fixed number of storage sessions', async () => {
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

    await expect(restoreLiveSpendableOutputs()).resolves.toEqual({
      restored: 60,
      unscripted: 0,
    })
    // Re-entering the provider per row is what made this seconds long on a
    // phone. Classify and write are one session each, whatever the row count.
    expect(runAsStorageProvider).toHaveBeenCalledTimes(2)
  })

  it('does nothing without an unlocked wallet', async () => {
    mockGetActiveWallet.mockReturnValue(null)
    await expect(restoreLiveSpendableOutputs()).resolves.toEqual({
      restored: 0,
      unscripted: 0,
    })
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

  it('rebuilds a script-less change row from the body it just signed', async () => {
    const { P2PKH, Transaction } = await import('@bsv/sdk')
    const body = new Transaction()
    body.addOutput({
      satoshis: 55_515,
      lockingScript: new P2PKH().lock('1BitcoinEaterAddressDontSendf59kuE'),
    })
    const txid = body.id('hex')

    findOutputs.mockResolvedValue([
      {
        outputId: 12,
        txid,
        vout: 0,
        change: true,
        satoshis: 55_515,
        spendable: false,
      },
    ])

    await expect(
      keepChangeOfSignedTx(txid, undefined, true, body.toBinary()),
    ).resolves.toBe(1)
    expect(updateOutput).toHaveBeenCalledWith(
      12,
      expect.objectContaining({
        spendable: true,
        lockingScript: body.outputs[0]!.lockingScript.toBinary(),
      }),
    )
  })

  it('refuses a script-less row whose body does not match, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { P2PKH, Transaction } = await import('@bsv/sdk')
      const body = new Transaction()
      body.addOutput({
        satoshis: 55_515,
        lockingScript: new P2PKH().lock('1BitcoinEaterAddressDontSendf59kuE'),
      })
      const txid = body.id('hex')

      findOutputs.mockResolvedValue([
        {
          outputId: 13,
          txid,
          vout: 0,
          change: true,
          // Not the amount this body pays — the script would be another coin's.
          satoshis: 999,
          spendable: false,
        },
      ])

      await expect(
        keepChangeOfSignedTx(txid, undefined, true, body.toBinary()),
      ).resolves.toBe(0)
      expect(updateOutput).not.toHaveBeenCalled()
      expect(
        warn.mock.calls.some((call) =>
          String(call[0]).includes('have no locking script'),
        ),
      ).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  it('promotes received (non-change) BSV outs so apps can chain them', async () => {
    const txid = 'ab'.repeat(32)
    findOutputs.mockResolvedValue([
      {
        outputId: 3,
        txid,
        vout: 0,
        change: false,
        satoshis: 2500,
        spendable: false,
        lockingScript: [118, 169],
      },
    ])

    await expect(keepChangeOfSignedTx(txid)).resolves.toBe(1)
    expect(updateOutput).toHaveBeenCalledWith(3, {
      spendable: true,
      spentBy: undefined,
    })
  })
})

describe('promotePendingLocalChangeOutputs', () => {
  const findTransactions = vi.fn()
  const findOutputs = vi.fn()
  const updateOutput = vi.fn()
  const updateTransactionStatus = vi.fn()

  beforeEach(() => {
    findTransactions.mockReset()
    findOutputs.mockReset()
    updateOutput.mockReset()
    updateTransactionStatus.mockReset()
    txExistsOnChain.mockReset()
    txExistsOnChain.mockResolvedValue(null)
    overlayStore.clear()
    __resetArcadeSubmitGuardForTests()
    __resetUtxoLocksForTests()
    mockGetActiveWallet.mockReset()
    mockGetActiveWallet.mockReturnValue({
      chain: 'main',
      address: '1abc',
      wallet: {
        storage: {
          findTransactions,
          findOutputs,
          updateTransactionStatus,
          runAsStorageProvider: async (
            fn: (sp: {
              updateOutput: typeof updateOutput
              findOutputs: typeof findOutputs
              findTransactions: typeof findTransactions
              updateTransactionStatus: typeof updateTransactionStatus
              getProvenOrRawTx: () => Promise<undefined>
            }) => Promise<unknown>,
          ) =>
            fn({
              updateOutput,
              findOutputs,
              findTransactions,
              updateTransactionStatus,
              getProvenOrRawTx: async () => undefined,
            }),
        },
      },
    })
  })

  it('promotes change from live pending txs without paging unspendable rows', async () => {
    const txid = 'ef'.repeat(32)
    txExistsOnChain.mockResolvedValue(true)
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

  it('promotes pending txs while explorers lag instead of failing the submit', async () => {
    const txid = 'cd'.repeat(32)
    txExistsOnChain.mockResolvedValue(false)
    findTransactions.mockImplementation(async (args: {
      status?: string[]
      partial?: { txid?: string }
    }) => {
      if (args.partial?.txid === txid || args.status?.includes('unproven')) {
        return [{ transactionId: 11, txid, status: 'unproven' }]
      }
      return []
    })
    findOutputs.mockResolvedValue([
      {
        outputId: 4,
        txid,
        vout: 0,
        change: true,
        satoshis: 2614,
        lockingScript: [0x76, 0xa9],
        spendable: false,
      },
    ])

    await expect(promotePendingLocalChangeOutputs()).resolves.toBe(1)
    expect(updateTransactionStatus).not.toHaveBeenCalled()
    expect(updateOutput).toHaveBeenCalledWith(
      4,
      expect.objectContaining({ spendable: true }),
    )
  })

  it('localOnly promote skips explorer exists-checks', async () => {
    const txid = 'ab'.repeat(32)
    findTransactions.mockResolvedValue([
      { transactionId: 3, txid, status: 'unproven' },
    ])
    findOutputs.mockResolvedValue([
      {
        outputId: 2,
        txid,
        vout: 0,
        change: true,
        satoshis: 1000,
        lockingScript: [0x76, 0xa9],
        spendable: false,
      },
    ])

    await expect(
      promotePendingLocalChangeOutputs({ forSpendChain: true, localOnly: true }),
    ).resolves.toBe(1)
    expect(txExistsOnChain).not.toHaveBeenCalled()
    expect(updateTransactionStatus).not.toHaveBeenCalled()
  })

  it('frees change of an Arcade-pinned nosend leg so the next leg can spend it', async () => {
    const txid = '1a'.repeat(32)
    rememberArcadeSubmitContact(txid)
    findTransactions.mockImplementation(async (args: {
      status?: string[]
      partial?: { txid?: string }
    }) => {
      if (args.partial?.txid === txid) {
        return [{ transactionId: 7, txid, status: 'nosend' }]
      }
      return args.status?.includes('nosend') ? [{ txid, status: 'nosend' }] : []
    })
    findOutputs.mockResolvedValue([
      {
        outputId: 9,
        txid,
        vout: 1,
        change: true,
        satoshis: 1_070_674,
        lockingScript: [0x76, 0xa9],
        spendable: false,
      },
    ])

    await expect(promotePendingLocalChangeOutputs()).resolves.toBe(1)
    expect(updateTransactionStatus).toHaveBeenCalledWith('unproven', 7)
    expect(updateOutput).toHaveBeenCalledWith(
      9,
      expect.objectContaining({ spendable: true }),
    )
  })

  it('does not re-seal a live tx it already promoted, until a coin is un-sealed', async () => {
    const txid = '3c'.repeat(32)
    txExistsOnChain.mockResolvedValue(true)
    findTransactions.mockImplementation(async (args: { status?: string[] }) =>
      args.status?.includes('unproven') ? [{ txid, status: 'unproven' }] : [],
    )
    findOutputs.mockResolvedValue([
      {
        outputId: 5,
        txid,
        vout: 1,
        change: true,
        satoshis: 4200,
        lockingScript: [0x76, 0xa9],
        spendable: false,
      },
    ])

    await expect(
      promotePendingLocalChangeOutputs({ forSpendChain: true }),
    ).resolves.toBe(1)
    const afterFirst = findOutputs.mock.calls.length
    expect(afterFirst).toBeGreaterThan(0)

    // Repeat sends must not pay the per-tx storage walk again — that is the
    // ~19s "Preparing payment" seen in the field.
    await expect(
      promotePendingLocalChangeOutputs({ forSpendChain: true }),
    ).resolves.toBe(0)
    expect(findOutputs.mock.calls.length).toBe(afterFirst)

    // An un-seal from any other path must force the walk again.
    creditUtxo(`${'9f'.repeat(32)}.0`, { satoshis: 10 })
    await promotePendingLocalChangeOutputs({ forSpendChain: true })
    expect(findOutputs.mock.calls.length).toBeGreaterThan(afterFirst)
  })

  it('leaves change of an unpinned nosend tx app-held', async () => {
    const txid = '2b'.repeat(32)
    findTransactions.mockImplementation(async (args: { status?: string[] }) =>
      args.status?.includes('nosend') ? [{ txid, status: 'nosend' }] : [],
    )
    findOutputs.mockResolvedValue([])

    await expect(promotePendingLocalChangeOutputs()).resolves.toBe(0)
    expect(updateTransactionStatus).not.toHaveBeenCalled()
    expect(updateOutput).not.toHaveBeenCalled()
  })
})

describe('pinBroadcastLocalTx', () => {
  const findTransactions = vi.fn()
  const findOutputs = vi.fn()
  const updateOutput = vi.fn()
  const updateTransactionStatus = vi.fn()
  const updateTransaction = vi.fn()

  beforeEach(() => {
    findTransactions.mockReset()
    findOutputs.mockReset()
    findOutputs.mockResolvedValue([])
    updateOutput.mockReset()
    updateTransactionStatus.mockReset()
    updateTransaction.mockReset()
    overlayStore.clear()
    __resetArcadeSubmitGuardForTests()
    __resetUtxoLocksForTests()
    mockGetActiveWallet.mockReset()
    mockGetActiveWallet.mockReturnValue({
      chain: 'main',
      address: '1abc',
      wallet: {
        storage: {
          runAsStorageProvider: async (
            fn: (sp: {
              updateOutput: typeof updateOutput
              findOutputs: typeof findOutputs
              findTransactions: typeof findTransactions
              updateTransactionStatus: typeof updateTransactionStatus
              updateTransaction: typeof updateTransaction
              getProvenOrRawTx: () => Promise<undefined>
            }) => Promise<unknown>,
          ) =>
            fn({
              updateOutput,
              findOutputs,
              findTransactions,
              updateTransactionStatus,
              updateTransaction,
              getProvenOrRawTx: async () => undefined,
            }),
        },
      },
    })
  })

  it('hands an app-held nosend row to the network side and frees its change', async () => {
    const txid = '3c'.repeat(32)
    findTransactions.mockResolvedValue([
      { transactionId: 4, txid, status: 'nosend' },
    ])
    findOutputs.mockResolvedValue([
      {
        outputId: 5,
        txid,
        vout: 2,
        change: true,
        satoshis: 236_416,
        lockingScript: [0x76, 0xa9],
        spendable: false,
      },
    ])

    await expect(pinBroadcastLocalTx(txid)).resolves.toBe(true)
    expect(updateTransactionStatus).toHaveBeenCalledWith('unproven', 4)
    expect(updateOutput).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ spendable: true }),
    )
  })

  it('still frees change when the broadcast tx has no local row yet', async () => {
    const { P2PKH, Transaction } = await import('@bsv/sdk')
    const body = new Transaction()
    body.addOutput({
      satoshis: 74_082,
      lockingScript: new P2PKH().lock('1BitcoinEaterAddressDontSendf59kuE'),
    })
    const txid = body.id('hex')
    findTransactions.mockResolvedValue([])
    findOutputs.mockResolvedValue([
      {
        outputId: 21,
        txid,
        vout: 0,
        change: true,
        satoshis: 74_082,
        spendable: false,
      },
    ])

    await expect(pinBroadcastLocalTx(txid, body.toBinary())).resolves.toBe(true)
    expect(updateOutput).toHaveBeenCalledWith(
      21,
      expect.objectContaining({ spendable: true }),
    )
  })

  it('reconnects detached self-send change from the signed body', async () => {
    const { P2PKH, Transaction } = await import('@bsv/sdk')
    const body = new Transaction()
    body.addOutput({
      satoshis: 1,
      lockingScript: new P2PKH().lock('1BitcoinEaterAddressDontSendf59kuE'),
    })
    body.addOutput({
      satoshis: 899_280,
      lockingScript: new P2PKH().lock('1CounterpartyXXXXXXXXXXXXXXXUWLpVr'),
    })
    const txid = body.id('hex')
    findTransactions.mockResolvedValue([])
    findOutputs.mockImplementation(
      async (args: { partial?: { txid?: string; spendable?: boolean } }) => {
        if (args.partial?.txid) return []
        if (args.partial?.spendable === false) {
          return [
            {
              outputId: 22,
              vout: 1,
              change: true,
              satoshis: 899_280,
              lockingScript: body.outputs[1]!.lockingScript.toBinary(),
              spendable: false,
            },
          ]
        }
        return []
      },
    )

    await expect(pinBroadcastLocalTx(txid, body.toBinary())).resolves.toBe(true)
    expect(updateOutput).toHaveBeenCalledWith(
      22,
      expect.objectContaining({ spendable: true }),
    )
  })

  it('does not rewrite the status of an already live row', async () => {
    const txid = '4d'.repeat(32)
    findTransactions.mockResolvedValue([
      { transactionId: 6, txid, status: 'unproven' },
    ])

    await expect(pinBroadcastLocalTx(txid)).resolves.toBe(true)
    expect(updateTransactionStatus).not.toHaveBeenCalled()
  })

  it('finds fresh noSend change linked only by transactionId', async () => {
    const txid = '5e'.repeat(32)
    findTransactions.mockResolvedValue([
      { transactionId: 8, txid, status: 'nosend' },
    ])
    findOutputs.mockImplementation(
      async (args: { partial?: { txid?: string; transactionId?: number } }) =>
        args.partial?.transactionId === 8
          ? [
              {
                outputId: 10,
                transactionId: 8,
                vout: 2,
                change: true,
                satoshis: 1_070_674,
                lockingScript: [0x76, 0xa9],
                spendable: false,
              },
            ]
          : [],
    )

    await expect(pinBroadcastLocalTx(txid)).resolves.toBe(true)
    expect(updateOutput).toHaveBeenCalledWith(
      10,
      expect.objectContaining({ spendable: true }),
    )
  })

  it('restores stale failed status when the same tx has an Arcade ACK', async () => {
    const txid = '6f'.repeat(32)
    rememberArcadeSubmitContact(txid)
    findTransactions.mockResolvedValue([
      { transactionId: 11, txid, status: 'failed' },
    ])
    findOutputs.mockResolvedValue([])

    await expect(pinBroadcastLocalTx(txid)).resolves.toBe(true)
    expect(updateTransaction).toHaveBeenCalledWith(11, {
      status: 'unproven',
    })
  })
})

describe('healAppHeldChange', () => {
  const findTransactions = vi.fn()
  const findOutputs = vi.fn()
  const updateOutput = vi.fn()
  const updateTransactionStatus = vi.fn()
  const findUserByIdentityKey = vi.fn()

  beforeEach(() => {
    findTransactions.mockReset()
    findOutputs.mockReset()
    findOutputs.mockResolvedValue([])
    updateOutput.mockReset()
    updateTransactionStatus.mockReset()
    findUserByIdentityKey.mockReset()
    findUserByIdentityKey.mockResolvedValue({ userId: 7 })
    overlayStore.clear()
    __resetArcadeSubmitGuardForTests()
    __resetUtxoLocksForTests()
    __resetReclaimSealCursorsForTests()
    mockGetActiveWallet.mockReset()
    mockGetActiveWallet.mockReturnValue({
      chain: 'main',
      address: '1abc',
      wallet: {
        identityKey: '02'.repeat(33),
        storage: {
          runAsStorageProvider: async (fn: (sp: unknown) => Promise<unknown>) =>
            fn({
              updateOutput,
              findOutputs,
              findTransactions,
              findUserByIdentityKey,
              updateTransactionStatus,
              updateTransaction: vi.fn(),
              getProvenOrRawTx: async () => undefined,
            }),
        },
      },
    })
  })

  it('frees change held behind a nosend parent the network already took', async () => {
    // Toolbox funding only draws on completed / unproven / sending parents, so
    // an app that signs noSend and never finalizes hides the payer's entire
    // managed change while the balance still counts it.
    const txid = '7a'.repeat(32)
    rememberArcadeSubmitContact(txid)
    findTransactions.mockImplementation(
      async (args: { partial?: { status?: string; txid?: string } }) =>
        args.partial?.status === 'nosend' || args.partial?.txid === txid
          ? [{ transactionId: 12, txid, status: 'nosend' }]
          : [],
    )
    findOutputs.mockImplementation(
      async (args: { partial?: { txid?: string } }) =>
        args.partial?.txid === txid
          ? [
              {
                outputId: 31,
                txid,
                vout: 1,
                change: true,
                satoshis: 104_605,
                lockingScript: [0x76, 0xa9],
                spendable: false,
              },
            ]
          : [],
    )

    await expect(healAppHeldChange()).resolves.toBe(1)
    expect(updateTransactionStatus).toHaveBeenCalledWith('unproven', 12)
    expect(updateOutput).toHaveBeenCalledWith(
      31,
      expect.objectContaining({ spendable: true }),
    )
  })

  it('asks the transactions store by its real index, never by txid alone', async () => {
    // IndexedDB only indexes `txid_userId`. A txid-only partial degrades to a
    // full cursor scan that can come back empty under load, which every pin
    // gate here used to read as proof the transaction did not exist.
    const txid = '8b'.repeat(32)
    rememberArcadeSubmitContact(txid)
    findTransactions.mockResolvedValue([
      { transactionId: 13, txid, status: 'nosend' },
    ])

    await healAppHeldChange()

    expect(findTransactions).toHaveBeenCalled()
    for (const [args] of findTransactions.mock.calls) {
      const partial = (args as { partial?: Record<string, unknown> }).partial
      expect(partial?.userId).toBe(7)
    }
  })

  it('leaves an app-held parent the network has not taken alone', async () => {
    const txid = '9c'.repeat(32)
    txExistsOnChain.mockResolvedValue(false)
    findTransactions.mockImplementation(
      async (args: { partial?: { status?: string } }) =>
        args.partial?.status === 'nosend'
          ? [{ transactionId: 14, txid, status: 'nosend' }]
          : [],
    )

    await expect(healAppHeldChange()).resolves.toBe(0)
    expect(updateTransactionStatus).not.toHaveBeenCalled()
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
    expect(getUtxoLock(`${txid}.1`)?.spentBy).toBeNull()
    expect(getUtxoLock(`${txid}.1`)?.diagnostic).toBe('quarantine:spent-unknown')
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
  const findTransactions = vi.fn()
  const updateTransactionStatus = vi.fn()

  beforeEach(() => {
    findOutputs.mockReset()
    updateOutput.mockReset()
    findTransactions.mockReset()
    updateTransactionStatus.mockReset()
    findTransactions.mockResolvedValue([])
    overlayStore.clear()
    __resetUtxoLocksForTests()
    mockGetActiveWallet.mockReset()
    mockGetActiveWallet.mockReturnValue({
      chain: 'main',
      wallet: {
        storage: {
          findOutputs,
          findTransactions,
          updateTransactionStatus,
          runAsStorageProvider: async (
            fn: (sp: {
              updateOutput: typeof updateOutput
              findOutputs: typeof findOutputs
              findTransactions: typeof findTransactions
              updateTransactionStatus: typeof updateTransactionStatus
            }) => Promise<unknown>,
          ) =>
            fn({
              updateOutput,
              findOutputs,
              findTransactions,
              updateTransactionStatus,
            }),
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

    findTransactions.mockResolvedValue([
      { transactionId: 42, txid: tx.id('hex'), status: 'unproven' },
    ])
    findOutputs.mockResolvedValue([
      { outputId: 9, txid: prevTxid, vout: 0, satoshis: 5000, spendable: true },
      {
        outputId: 10,
        txid: tx.id('hex'),
        vout: 0,
        satoshis: 900,
        spendable: true,
        change: true,
      },
    ])

    await expect(
      releaseSealedInputsOfUnsentTx(tx.id('hex'), tx.toBinary()),
    ).resolves.toBe(1)

    const lock = getUtxoLock(`${prevTxid}_0`)
    expect(lock?.spendable).toBe(true)
    expect(lock?.spentBy).toBeNull()
    expect(updateOutput).toHaveBeenCalledWith(9, { spendable: true })
    expect(updateTransactionStatus).toHaveBeenCalledWith('failed', 42)
    expect(updateOutput).toHaveBeenCalledWith(10, {
      spendable: false,
      spentBy: undefined,
    })
  })
})

describe('failUnsentLocalTx', () => {
  const findOutputs = vi.fn()
  const updateOutput = vi.fn()
  const findTransactions = vi.fn()
  const updateTransactionStatus = vi.fn()

  beforeEach(() => {
    findOutputs.mockReset()
    updateOutput.mockReset()
    findTransactions.mockReset()
    updateTransactionStatus.mockReset()
    mockGetActiveWallet.mockReset()
    mockGetActiveWallet.mockReturnValue({
      chain: 'main',
      wallet: {
        storage: {
          runAsStorageProvider: async (
            fn: (sp: {
              updateOutput: typeof updateOutput
              findOutputs: typeof findOutputs
              findTransactions: typeof findTransactions
              updateTransactionStatus: typeof updateTransactionStatus
            }) => Promise<unknown>,
          ) =>
            fn({
              updateOutput,
              findOutputs,
              findTransactions,
              updateTransactionStatus,
            }),
        },
      },
    })
  })

  it('refuses to fail a live submitted tx while explorers lag', async () => {
    const txid = 'ab'.repeat(32)
    findTransactions.mockResolvedValue([
      { transactionId: 7, txid, status: 'unmined' },
    ])
    findOutputs.mockResolvedValue([
      { outputId: 1, txid, vout: 0, satoshis: 2614, spendable: false, change: true },
    ])

    await expect(failUnsentLocalTx(txid)).resolves.toBe(false)
    expect(updateTransactionStatus).not.toHaveBeenCalled()
    expect(updateOutput).not.toHaveBeenCalled()
  })

  it('refuses to fail an Arcade-pinned noSend row that is still unsent', async () => {
    overlayStore.clear()
    __resetArcadeSubmitGuardForTests()
    const txid = 'cd'.repeat(32)
    rememberArcadeSubmitContact(txid)
    findTransactions.mockResolvedValue([
      { transactionId: 8, txid, status: 'unsent' },
    ])
    findOutputs.mockResolvedValue([
      { outputId: 1, txid, vout: 0, satoshis: 1, spendable: false, change: false },
    ])

    await expect(failUnsentLocalTx(txid)).resolves.toBe(false)
    expect(updateTransactionStatus).not.toHaveBeenCalled()
    expect(updateOutput).not.toHaveBeenCalled()
  })
})

describe('restoreOnChainLocalTx', () => {
  const findOutputs = vi.fn()
  const updateOutput = vi.fn()
  const findTransactions = vi.fn()
  const updateTransactionStatus = vi.fn()
  const updateTransaction = vi.fn()

  beforeEach(() => {
    findOutputs.mockReset()
    updateOutput.mockReset()
    findTransactions.mockReset()
    updateTransactionStatus.mockReset()
    updateTransaction.mockReset()
    txExistsOnChain.mockReset()
    txExistsOnChain.mockResolvedValue(null)
    overlayStore.clear()
    __resetUtxoLocksForTests()
    mockGetActiveWallet.mockReset()
    mockGetActiveWallet.mockReturnValue({
      chain: 'main',
      wallet: {
        storage: {
          runAsStorageProvider: async (
            fn: (sp: {
              updateOutput: typeof updateOutput
              findOutputs: typeof findOutputs
              findTransactions: typeof findTransactions
              updateTransactionStatus: typeof updateTransactionStatus
              updateTransaction: typeof updateTransaction
              getProvenOrRawTx: () => Promise<undefined>
            }) => Promise<unknown>,
          ) =>
            fn({
              updateOutput,
              findOutputs,
              findTransactions,
              updateTransactionStatus,
              updateTransaction,
              getProvenOrRawTx: async () => undefined,
            }),
        },
      },
    })
  })

  it('unfails a local failed row only when explorers prove the tx landed', async () => {
    const txid = 'ad'.repeat(32)
    txExistsOnChain.mockResolvedValue(true)
    findTransactions.mockResolvedValue([
      { transactionId: 9, txid, status: 'failed' },
    ])
    findOutputs.mockResolvedValue([
      {
        outputId: 3,
        txid,
        vout: 1,
        satoshis: 2614,
        spendable: false,
        change: true,
        lockingScript: [118, 169],
      },
    ])

    await expect(restoreOnChainLocalTx(txid)).resolves.toBe(true)
    expect(updateTransaction).toHaveBeenCalledWith(9, { status: 'unproven' })
    expect(updateTransactionStatus).not.toHaveBeenCalled()
    expect(updateOutput).toHaveBeenCalledWith(
      3,
      expect.objectContaining({ spendable: true }),
    )
  })

  it('refuses to unfail when the explorer is silent or says absent', async () => {
    const txid = 'ad'.repeat(32)
    findTransactions.mockResolvedValue([
      { transactionId: 9, txid, status: 'failed' },
    ])

    txExistsOnChain.mockResolvedValue(null)
    await expect(restoreOnChainLocalTx(txid)).resolves.toBe(false)
    txExistsOnChain.mockResolvedValue(false)
    await expect(restoreOnChainLocalTx(txid)).resolves.toBe(false)
    expect(updateTransaction).not.toHaveBeenCalled()
  })

  it('coerces unmined to unproven without an explorer round-trip', async () => {
    const txid = 'cd'.repeat(32)
    findTransactions.mockResolvedValue([
      { transactionId: 4, txid, status: 'unmined' },
    ])
    findOutputs.mockResolvedValue([])

    await expect(restoreOnChainLocalTx(txid)).resolves.toBe(true)
    expect(txExistsOnChain).not.toHaveBeenCalled()
    expect(updateTransactionStatus).toHaveBeenCalledWith('unproven', 4)
  })

  it('coerces noSend unsent rows to unproven after miner submit', async () => {
    const txid = 'ef'.repeat(32)
    findTransactions.mockResolvedValue([
      { transactionId: 5, txid, status: 'unsent' },
    ])
    findOutputs.mockResolvedValue([])

    await expect(restoreOnChainLocalTx(txid)).resolves.toBe(true)
    expect(txExistsOnChain).not.toHaveBeenCalled()
    expect(updateTransactionStatus).toHaveBeenCalledWith('unproven', 5)
  })
})

describe('reclaimSealedInputsNeverSpent', () => {
  const findTransactions = vi.fn()
  const findOutputs = vi.fn()
  const updateOutput = vi.fn()
  const isUtxo = vi.fn()

  beforeEach(() => {
    findTransactions.mockReset()
    findOutputs.mockReset()
    updateOutput.mockReset()
    isUtxo.mockReset()
    overlayStore.clear()
    __resetUtxoLocksForTests()
    __resetArcadeSubmitGuardForTests()
    __resetReclaimSealCursorsForTests()
    reimportDerivedChangeOutpoints.mockReset()
    reimportDerivedChangeOutpoints.mockResolvedValue({
      imported: 0,
      skipped: 0,
      failed: 0,
    })
    txExistsOnChain.mockReset()
    spentStatusOfOutpoint.mockReset()
    txExistsOnChain.mockResolvedValue(false)
    spentStatusOfOutpoint.mockResolvedValue('unspent')
    mockGetActiveWallet.mockReset()
    mockGetActiveWallet.mockReturnValue({
      chain: 'main',
      services: { isUtxo },
      wallet: {
        storage: {
          runAsStorageProvider: async (
            fn: (sp: {
              updateOutput: typeof updateOutput
              findTransactions: typeof findTransactions
              findOutputs: typeof findOutputs
            }) => Promise<unknown>,
          ) => fn({ updateOutput, findTransactions, findOutputs }),
        },
      },
    })
  })

  it('does not un-deduct inputs of a live callback spend just because explorers lag', async () => {
    const prevTxid = 'aa'.repeat(32)
    const sealer = 'bb'.repeat(32)
    hideUtxo(`${prevTxid}_0`, { spentBy: sealer, satoshis: 1299000 })
    findTransactions.mockResolvedValue([{ txid: sealer, status: 'callback' }])

    await expect(
      reclaimSealedInputsNeverSpent({ forSpendChain: true }),
    ).resolves.toBe(0)
    expect(updateOutput).not.toHaveBeenCalled()
    expect(getUtxoLock(`${prevTxid}_0`)?.spendable).toBe(false)
    expect(getUtxoLock(`${prevTxid}_0`)?.spentBy).toBe(sealer)
  })

  it('does not reclaim Arcade-pinned item noSend inputs when explorers lag', async () => {
    const prevTxid = '11'.repeat(32)
    const sealer = '33'.repeat(32)
    hideUtxo(`${prevTxid}_0`, { spentBy: sealer, satoshis: 1 })
    rememberArcadeSubmitContact(sealer)
    findTransactions.mockResolvedValue([{ txid: sealer, status: 'unsent' }])
    txExistsOnChain.mockResolvedValue(false)
    spentStatusOfOutpoint.mockResolvedValue('unspent')
    isUtxo.mockResolvedValue(true)

    await expect(
      reclaimSealedInputsNeverSpent({ forSpendChain: true }),
    ).resolves.toBe(0)
    expect(updateOutput).not.toHaveBeenCalled()
    expect(getUtxoLock(`${prevTxid}_0`)?.spendable).toBe(false)
    expect(getUtxoLock(`${prevTxid}_0`)?.spentBy).toBe(sealer)
  })

  it('does not reclaim sealed inputs when the sealer has no local tx row', async () => {
    const prevTxid = '22'.repeat(32)
    const sealer = '44'.repeat(32)
    hideUtxo(`${prevTxid}_0`, { spentBy: sealer, satoshis: 500_000 })
    findTransactions.mockResolvedValue([])
    txExistsOnChain.mockResolvedValue(null)
    spentStatusOfOutpoint.mockResolvedValue('unknown')
    isUtxo.mockResolvedValue(true)

    await expect(
      reclaimSealedInputsNeverSpent({ forSpendChain: true }),
    ).resolves.toBe(0)
    expect(updateOutput).not.toHaveBeenCalled()
    expect(getUtxoLock(`${prevTxid}_0`)?.spendable).toBe(false)
    expect(getUtxoLock(`${prevTxid}_0`)?.spentBy).toBe(sealer)
  })

  it('does not reclaim when explorer 404s but sealed inputs are already spent', async () => {
    const prevTxid = '55'.repeat(32)
    const sealer = '66'.repeat(32)
    hideUtxo(`${prevTxid}_0`, { spentBy: sealer, satoshis: 250_000 })
    findTransactions.mockResolvedValue([{ txid: sealer, status: 'unsent' }])
    txExistsOnChain.mockResolvedValue(false)
    spentStatusOfOutpoint.mockResolvedValue('spent')
    isUtxo.mockResolvedValue(false)

    await expect(
      reclaimSealedInputsNeverSpent({ forSpendChain: true }),
    ).resolves.toBe(0)
    expect(updateOutput).not.toHaveBeenCalled()
    expect(getUtxoLock(`${prevTxid}_0`)?.spendable).toBe(false)
  })

  it('recovers only proven-unspent siblings of a failed multi-input spend', async () => {
    const liveParent = '77'.repeat(32)
    const spentParent = '88'.repeat(32)
    const sealer = '99'.repeat(32)
    hideUtxo(`${liveParent}_0`, { spentBy: sealer, satoshis: 400 })
    hideUtxo(`${spentParent}_1`, { spentBy: sealer, satoshis: 600 })
    findTransactions.mockResolvedValue([{ txid: sealer, status: 'failed' }])
    isUtxo.mockImplementation(async ({ txid }: { txid: string }) => txid === liveParent)
    spentStatusOfOutpoint.mockImplementation(async (outpoint: string) =>
      outpoint.startsWith(spentParent) ? 'spent' : 'unspent',
    )
    findOutputs.mockImplementation(async ({ partial }: { partial?: { txid?: string } }) => {
      if (partial?.txid === liveParent) {
        return [{ outputId: 10, txid: liveParent, vout: 0, spendable: false }]
      }
      if (partial?.txid === spentParent) {
        return [{ outputId: 11, txid: spentParent, vout: 1, spendable: false }]
      }
      return []
    })

    await expect(
      reclaimSealedInputsNeverSpent({ forSpendChain: true }),
    ).resolves.toBe(1)
    expect(getUtxoLock(`${liveParent}_0`)?.spendable).toBe(true)
    expect(getUtxoLock(`${spentParent}_1`)?.spendable).toBe(false)
    expect(updateOutput).toHaveBeenCalledWith(10, {
      spendable: true,
      spentBy: undefined,
    })
    expect(updateOutput).not.toHaveBeenCalledWith(
      11,
      expect.objectContaining({ spendable: true }),
    )
  })

  it('reimports blank-sealed coins that are live on chain but have no toolbox row', async () => {
    const txid = 'ab'.repeat(32)
    hideUtxo(`${txid}_4`, { diagnostic: 'already-spent', satoshis: 575_245 })
    isUtxo.mockResolvedValue(true)
    findOutputs.mockResolvedValue([])
    findTransactions.mockResolvedValue([])
    reimportDerivedChangeOutpoints.mockResolvedValue({
      imported: 1,
      skipped: 0,
      failed: 0,
    })

    await expect(
      reclaimSealedInputsNeverSpent({ forSpendChain: true }),
    ).resolves.toBe(1)
    expect(updateOutput).not.toHaveBeenCalled()
    expect(reimportDerivedChangeOutpoints).toHaveBeenCalledWith([`${txid}_4`])
  })

  it('updates a blank-sealed row linked only by transactionId', async () => {
    const txid = 'cd'.repeat(32)
    hideUtxo(`${txid}_2`, { diagnostic: 'already-spent', satoshis: 530_259 })
    isUtxo.mockResolvedValue(true)
    findOutputs.mockImplementation(
      async ({
        partial,
      }: {
        partial?: { txid?: string; transactionId?: number }
      }) => {
        if (partial?.txid === txid) return []
        if (partial?.transactionId === 9) {
          return [{ outputId: 22, transactionId: 9, vout: 2, spendable: false }]
        }
        return []
      },
    )
    findTransactions.mockResolvedValue([{ txid, transactionId: 9 }])

    await expect(
      reclaimSealedInputsNeverSpent({ forSpendChain: true }),
    ).resolves.toBe(1)
    expect(updateOutput).toHaveBeenCalledWith(22, {
      spendable: true,
      spentBy: undefined,
    })
    expect(reimportDerivedChangeOutpoints).not.toHaveBeenCalled()
    expect(getUtxoLock(`${txid}_2`)?.spendable).toBe(true)
  })
})

describe('reclaimOutputsSealedByDeadTxs', () => {
  const findTransactions = vi.fn()
  const findOutputs = vi.fn()
  const updateOutput = vi.fn()
  const isUtxo = vi.fn()

  /** Storage the overlay never knew about — a seal from an earlier install. */
  const storageOnly = (
    rows: Array<Record<string, unknown>>,
    txRows: Record<number, { status: string; txid?: string }>,
  ) => {
    findOutputs.mockImplementation(
      async ({
        partial,
        paged,
      }: {
        partial?: { spendable?: boolean }
        paged?: { offset?: number }
      }) => {
        if (partial?.spendable !== false) return []
        return (paged?.offset ?? 0) === 0 ? rows : []
      },
    )
    findTransactions.mockImplementation(
      async ({ partial }: { partial?: { transactionId?: number } }) => {
        const id = partial?.transactionId
        const row = id == null ? undefined : txRows[id]
        return row ? [{ transactionId: id, ...row }] : []
      },
    )
  }

  beforeEach(() => {
    findTransactions.mockReset()
    findOutputs.mockReset()
    updateOutput.mockReset()
    isUtxo.mockReset()
    overlayStore.clear()
    __resetUtxoLocksForTests()
    __resetArcadeSubmitGuardForTests()
    txExistsOnChain.mockReset()
    spentStatusOfOutpoint.mockReset()
    txExistsOnChain.mockResolvedValue(true)
    spentStatusOfOutpoint.mockResolvedValue('unspent')
    mockGetActiveWallet.mockReset()
    mockGetActiveWallet.mockReturnValue({
      chain: 'main',
      services: { isUtxo },
      wallet: {
        storage: {
          runAsStorageProvider: async (
            fn: (sp: {
              updateOutput: typeof updateOutput
              findTransactions: typeof findTransactions
              findOutputs: typeof findOutputs
            }) => Promise<unknown>,
          ) => fn({ updateOutput, findTransactions, findOutputs }),
        },
      },
    })
  })

  it('restores cash the toolbox still shows spent by a doubleSpend tx', async () => {
    const funder = 'a1'.repeat(32)
    isUtxo.mockResolvedValue(true)
    storageOnly(
      [
        {
          outputId: 21,
          txid: funder,
          vout: 0,
          satoshis: 8822,
          spendable: false,
          spentBy: 77,
        },
      ],
      { 77: { status: 'doubleSpend' } },
    )

    await expect(reclaimOutputsSealedByDeadTxs()).resolves.toBe(1)
    expect(updateOutput).toHaveBeenCalledWith(21, {
      spendable: true,
      spentBy: undefined,
    })
  })

  it('resolves a coin whose row links its sealer only by transactionId', async () => {
    const funder = 'b2'.repeat(32)
    isUtxo.mockResolvedValue(true)
    storageOnly(
      [
        {
          outputId: 22,
          vout: 1,
          satoshis: 4000,
          spendable: false,
          spentBy: 78,
        },
      ],
      { 78: { status: 'failed', txid: funder } },
    )

    await expect(reclaimOutputsSealedByDeadTxs()).resolves.toBe(1)
    expect(updateOutput).toHaveBeenCalledWith(22, {
      spendable: true,
      spentBy: undefined,
    })
  })

  it('leaves a coin sealed while its spend is still live', async () => {
    const funder = 'c3'.repeat(32)
    isUtxo.mockResolvedValue(true)
    storageOnly(
      [
        {
          outputId: 23,
          txid: funder,
          vout: 0,
          satoshis: 9000,
          spendable: false,
          spentBy: 79,
        },
      ],
      { 79: { status: 'nosend' } },
    )

    await expect(reclaimOutputsSealedByDeadTxs()).resolves.toBe(0)
    expect(updateOutput).not.toHaveBeenCalled()
  })

  it('leaves a coin sealed when the sealer row is gone', async () => {
    const funder = 'd4'.repeat(32)
    isUtxo.mockResolvedValue(true)
    storageOnly(
      [
        {
          outputId: 24,
          txid: funder,
          vout: 0,
          satoshis: 9000,
          spendable: false,
          spentBy: 80,
        },
      ],
      {},
    )

    await expect(reclaimOutputsSealedByDeadTxs()).resolves.toBe(0)
    expect(updateOutput).not.toHaveBeenCalled()
  })

  it('refuses a dead-sealed coin the chain says is already spent', async () => {
    const funder = 'e5'.repeat(32)
    isUtxo.mockResolvedValue(false)
    spentStatusOfOutpoint.mockResolvedValue('spent')
    storageOnly(
      [
        {
          outputId: 25,
          txid: funder,
          vout: 0,
          satoshis: 9000,
          spendable: false,
          spentBy: 81,
        },
      ],
      { 81: { status: 'doubleSpend' } },
    )

    await expect(reclaimOutputsSealedByDeadTxs()).resolves.toBe(0)
    expect(updateOutput).not.toHaveBeenCalled()
  })

  it('never reclaims items or tokens as cash', async () => {
    const tip = 'f6'.repeat(32)
    isUtxo.mockResolvedValue(true)
    storageOnly(
      [
        {
          outputId: 26,
          txid: tip,
          vout: 0,
          satoshis: 1,
          spendable: false,
          spentBy: 82,
          basket: '1sat',
        },
        {
          outputId: 27,
          txid: tip,
          vout: 1,
          satoshis: 1000,
          spendable: false,
          spentBy: 82,
          basket: 'bsv21',
        },
      ],
      { 82: { status: 'doubleSpend' } },
    )

    await expect(reclaimOutputsSealedByDeadTxs()).resolves.toBe(0)
    expect(updateOutput).not.toHaveBeenCalled()
  })
})
