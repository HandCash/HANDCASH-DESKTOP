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

    expect(mockReviewSpendableOutputs).toHaveBeenCalledWith(true, true)
    expect(order).toEqual(['scan', 'review'])
    expect(mockClearCollectablesCache).toHaveBeenCalled()
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
    expect(mockReviewSpendableOutputs).toHaveBeenNthCalledWith(1, true, true)
    expect(mockReviewSpendableOutputs).toHaveBeenNthCalledWith(2, false, true)
    expect(mockScanLegacyAddress).toHaveBeenCalled()
  })

  it('does not release when spendable review throws', async () => {
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

  it('skips spendable review during legacy import grace window', async () => {
    const guard = await import('./legacyImportGuard')
    guard.noteLegacyImportSuccess(1)

    const { refreshFromChain } = await import('./chainIngest')
    await refreshFromChain({ forceReview: true, announceReceive: false })

    expect(mockReviewSpendableOutputs).not.toHaveBeenCalled()
    expect(mockScanLegacyAddress).toHaveBeenCalled()
  })
})
