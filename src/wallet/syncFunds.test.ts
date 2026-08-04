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

describe('syncLegacyFunds spendable review', () => {
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

  it('reviews all baskets with release before address scan when forced', async () => {
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

    const { syncLegacyFunds } = await import('./syncFunds')
    await syncLegacyFunds({ forceReview: true, announceReceive: false })

    expect(mockReviewSpendableOutputs).toHaveBeenCalledWith(true, true)
    expect(order).toEqual(['review', 'scan'])
    expect(mockClearCollectablesCache).toHaveBeenCalled()
  })

  it('does not release when spendable review throws', async () => {
    mockReviewSpendableOutputs.mockRejectedValue(new Error('provider down'))

    const { syncLegacyFunds } = await import('./syncFunds')
    const sats = await syncLegacyFunds({ forceReview: true, announceReceive: false })

    expect(sats).toBe(1000)
    expect(mockClearCollectablesCache).not.toHaveBeenCalled()
    expect(mockScanLegacyAddress).toHaveBeenCalled()
  })

  it('throttles background review but still scans', async () => {
    mockReviewSpendableOutputs.mockResolvedValue({ totalOutputs: 0, outputs: [] })

    const { syncLegacyFunds } = await import('./syncFunds')
    await syncLegacyFunds({ forceReview: true, announceReceive: false })
    mockReviewSpendableOutputs.mockClear()
    mockScanLegacyAddress.mockClear()

    await syncLegacyFunds({ announceReceive: false })

    expect(mockReviewSpendableOutputs).not.toHaveBeenCalled()
    expect(mockScanLegacyAddress).toHaveBeenCalled()
  })
})
