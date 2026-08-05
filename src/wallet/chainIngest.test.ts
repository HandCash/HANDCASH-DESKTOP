import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockReviewSpendableOutputs = vi.fn()
const mockFetchBalanceSats = vi.fn()
const mockScanLegacyAddress = vi.fn()
const mockClassifyLegacyUtxos = vi.fn()
const mockImportOneSatOrdinals = vi.fn()
const mockImportLegacyUtxos = vi.fn()
const mockClearCollectablesCache = vi.fn()
const mockSetSyncHealth = vi.fn()
const mockReconcilePendingSends = vi.fn()
const mockGetActiveWallet = vi.fn()

vi.mock('./session', () => ({
  getActiveWallet: () => mockGetActiveWallet(),
  fetchBalanceSats: (...args: unknown[]) => mockFetchBalanceSats(...args),
}))

vi.mock('./legacyScan', () => ({
  scanLegacyAddress: (...args: unknown[]) => mockScanLegacyAddress(...args),
  importLegacyUtxos: (...args: unknown[]) => mockImportLegacyUtxos(...args),
}))

vi.mock('./oneSatImport', () => ({
  classifyLegacyUtxos: (...args: unknown[]) => mockClassifyLegacyUtxos(...args),
  importOneSatOrdinals: (...args: unknown[]) => mockImportOneSatOrdinals(...args),
}))

vi.mock('./collectables', () => ({
  clearCollectablesCache: () => mockClearCollectablesCache(),
}))

vi.mock('./pendingSend', () => ({
  reconcilePendingSends: () => mockReconcilePendingSends(),
}))

vi.mock('./walletHealth', () => ({
  setSyncHealth: (...args: unknown[]) => mockSetSyncHealth(...args),
}))

vi.mock('./soundService', () => ({
  playWalletSound: vi.fn(),
}))

vi.mock('./toast', () => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  showToast: vi.fn(),
}))

vi.mock('./historyBackupPrefs', () => ({
  resolveHistoryBackupBaseUrl: () => null,
}))

describe('refreshFromChain spendable review', () => {
  beforeEach(() => {
    vi.resetModules()
    mockReviewSpendableOutputs.mockReset()
    mockFetchBalanceSats.mockReset()
    mockScanLegacyAddress.mockReset()
    mockClassifyLegacyUtxos.mockReset()
    mockImportOneSatOrdinals.mockReset()
    mockImportLegacyUtxos.mockReset()
    mockClearCollectablesCache.mockReset()
    mockSetSyncHealth.mockReset()
    mockReconcilePendingSends.mockReset()
    mockGetActiveWallet.mockReset()

    mockGetActiveWallet.mockReturnValue({
      chain: 'main',
      wallet: {
        reviewSpendableOutputs: mockReviewSpendableOutputs,
      },
    })
    mockFetchBalanceSats.mockResolvedValue(1000)
    mockScanLegacyAddress.mockResolvedValue({
      address: 'addr',
      chain: 'main',
      sats: 0,
      utxos: [],
      source: 'whatsonchain',
    })
    mockClassifyLegacyUtxos.mockResolvedValue({
      funding: [],
      oneSats: [],
      heldOneSats: [],
    })
  })

  it('scans legacy address before spendable review when forced', async () => {
    const order: string[] = []
    mockReviewSpendableOutputs.mockImplementation(async () => {
      order.push('review')
      return { totalOutputs: 1, outputs: [{ outpoint: 'aa.0', satoshis: 1 }] }
    })
    mockScanLegacyAddress.mockImplementation(async () => {
      order.push('scan')
      return {
        address: 'addr',
        chain: 'main',
        sats: 0,
        utxos: [],
        source: 'whatsonchain',
      }
    })

    const { refreshFromChain } = await import('./chainIngest')
    await refreshFromChain({ forceReview: true, announceReceive: false })

    expect(mockReviewSpendableOutputs).toHaveBeenCalledWith(true, false)
    expect(order).toEqual(['scan', 'review'])
  })

  it('falls back to default-basket review when all-basket filter rejects undefined', async () => {
    mockReviewSpendableOutputs
      .mockRejectedValueOnce(
        new Error(
          'WERR_INVALID_PARAMETER: The args.partial.basketId parameter must be not undefined. Passing undefined as a filter value is not supported — omit the key to skip filtering.',
        ),
      )
      .mockResolvedValueOnce({ totalOutputs: 0, outputs: [] })

    const { refreshFromChain } = await import('./chainIngest')
    const sats = await refreshFromChain({ forceReview: true, announceReceive: false })

    expect(sats).toBe(1000)
    expect(mockReviewSpendableOutputs).toHaveBeenNthCalledWith(1, true, false)
    expect(mockReviewSpendableOutputs).toHaveBeenNthCalledWith(2, false, false)
    expect(mockScanLegacyAddress).toHaveBeenCalled()
  })

  it('survives a spendable audit that throws', async () => {
    const order: string[] = []
    mockReviewSpendableOutputs.mockImplementation(async () => {
      order.push('review')
      throw new Error('provider down')
    })
    mockScanLegacyAddress.mockImplementation(async () => {
      order.push('scan')
      return {
        address: 'addr',
        chain: 'main',
        sats: 0,
        utxos: [],
        source: 'whatsonchain',
      }
    })

    const { refreshFromChain } = await import('./chainIngest')
    const sats = await refreshFromChain({ forceReview: true, announceReceive: false })

    expect(sats).toBe(1000)
    expect(order).toEqual(['scan', 'review'])
    expect(mockClearCollectablesCache).not.toHaveBeenCalled()
  })

  it('throttles background review but still scans', async () => {
    mockReviewSpendableOutputs.mockResolvedValue({ totalOutputs: 0, outputs: [] })

    const { refreshFromChain } = await import('./chainIngest')
    await refreshFromChain({ forceReview: true, announceReceive: false })
    mockReviewSpendableOutputs.mockClear()
    mockScanLegacyAddress.mockClear()

    await refreshFromChain({ announceReceive: false })

    expect(mockReviewSpendableOutputs).not.toHaveBeenCalled()
    expect(mockScanLegacyAddress).toHaveBeenCalled()
  })

  it('skips background review during legacy import grace window', async () => {
    const guard = await import('./legacyImportGuard')
    guard.noteLegacyImportSuccess(1)

    const { refreshFromChain } = await import('./chainIngest')
    await refreshFromChain({ announceReceive: false })

    expect(mockReviewSpendableOutputs).not.toHaveBeenCalled()
    expect(mockScanLegacyAddress).toHaveBeenCalled()
  })

  it('still audits when forced inside the grace window', async () => {
    mockReviewSpendableOutputs.mockResolvedValue({ totalOutputs: 0, outputs: [] })
    const guard = await import('./legacyImportGuard')
    guard.noteLegacyImportSuccess(1)

    const { refreshFromChain } = await import('./chainIngest')
    await refreshFromChain({ forceReview: true, announceReceive: false })

    expect(mockReviewSpendableOutputs).toHaveBeenCalledWith(true, false)
  })

  it('never releases during sync, however hard it is forced', async () => {
    mockReviewSpendableOutputs.mockResolvedValue({
      totalOutputs: 1,
      outputs: [{ outpoint: 'cc.1', satoshis: 4000 }],
    })

    const { refreshFromChain } = await import('./chainIngest')
    await refreshFromChain({ forceReview: true, announceReceive: false })

    // An unindexed output is not a spent output, and releasing is permanent.
    expect(mockReviewSpendableOutputs).toHaveBeenCalledWith(true, false)
    expect(mockReviewSpendableOutputs).not.toHaveBeenCalledWith(true, true)
  })

  it('reports unindexed outputs as suspect without condemning them', async () => {
    mockReviewSpendableOutputs.mockResolvedValue({
      totalOutputs: 1,
      outputs: [{ outpoint: 'cc.1', satoshis: 4000 }],
    })

    const { auditSpendableOutputs } = await import('./chainIngest')
    const result = await auditSpendableOutputs(true)

    expect(result).toEqual({ suspect: 1, skipped: false })
  })

  it('skips the audit when this pass swept legacy funding', async () => {
    mockReviewSpendableOutputs.mockResolvedValue({ totalOutputs: 0, outputs: [] })
    mockScanLegacyAddress.mockResolvedValue({
      address: 'addr',
      chain: 'main',
      sats: 5000,
      utxos: [{ outpoint: 'bb.0', txid: 'bb', vout: 0, satoshis: 5000 }],
      source: 'whatsonchain',
    })
    mockClassifyLegacyUtxos.mockResolvedValue({
      funding: [{ outpoint: 'bb.0', txid: 'bb', vout: 0, satoshis: 5000 }],
      oneSats: [],
      latches: [],
      heldOneSats: [],
    })
    const guard = await import('./legacyImportGuard')
    mockImportLegacyUtxos.mockImplementation(async () => {
      // A real sweep marks the outpoint imported, which opens the grace window.
      guard.noteLegacyImportSuccess(1)
      return {
        imported: 1,
        failed: 0,
        errors: [],
        skippedOneSats: 0,
        skippedKnown: 0,
        importedOutpoints: ['bb.0'],
        importedReceipts: [
          { outpoint: 'bb.0', satoshis: 5000, receiveTxid: 'bb', sweepTxid: 'cc' },
        ],
      }
    })

    const { refreshFromChain } = await import('./chainIngest')
    await refreshFromChain({ forceReview: true, announceReceive: false })

    expect(mockReviewSpendableOutputs).not.toHaveBeenCalled()
  })
})
