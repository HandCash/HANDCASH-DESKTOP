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

// Pre-scan maintenance — independent of each other, run as one parallel batch.
const mockReconcileDualLayerState = vi.fn(async () => ({
  checked: 0,
  mined: 0,
  failed: 0,
  orphaned: 0,
}))
const mockHealGhostSentItems = vi.fn(async (): Promise<string[]> => [])
const mockPruneMissingOnChainActivity = vi.fn(async () => 0)
const mockExpireStaleInboundPending = vi.fn(() => 0)
const mockRehideInputsOfLiveLocalTxs = vi.fn(async () => undefined)
const mockRestoreLiveSpendableOutputs = vi.fn(async () => 0)

vi.mock('./session', () => ({
  getActiveWallet: () => mockGetActiveWallet(),
  fetchBalanceSats: (...args: unknown[]) => mockFetchBalanceSats(...args),
}))

vi.mock('./legacyScan', () => ({
  scanLegacyAddress: (...args: unknown[]) => mockScanLegacyAddress(...args),
  importLegacyUtxos: (...args: unknown[]) => mockImportLegacyUtxos(...args),
  txExistsOnChain: vi.fn(async () => null),
}))

vi.mock('./txReconcile', () => ({
  reconcileDualLayerState: () => mockReconcileDualLayerState(),
}))

vi.mock('./sentItemGuard', () => ({
  healGhostSentItems: (...args: unknown[]) => mockHealGhostSentItems(...(args as [])),
}))

vi.mock('./appActivity', () => ({
  pruneMissingOnChainActivity: (...args: unknown[]) =>
    mockPruneMissingOnChainActivity(...(args as [])),
  expireStaleInboundPending: () => mockExpireStaleInboundPending(),
  // Also used by the real ingestLegacyAddress receipt writers below.
  hasActivityItemOutpoint: () => false,
  hasSettledActivityItemOutpoint: () => false,
  hasSettledActivityTxid: () => false,
  recordAppActivity: vi.fn(),
  upsertAppActivity: vi.fn(),
  formatActivityTokenAmt: (amt: string) => amt,
  WALLET_ACTIVITY_ORIGIN: 'wallet',
}))

vi.mock('./staleOutputRelease', () => ({
  rehideInputsOfLiveLocalTxs: () => mockRehideInputsOfLiveLocalTxs(),
  restoreLiveSpendableOutputs: () => mockRestoreLiveSpendableOutputs(),
  isUndefinedPartialFilterError: (err: unknown) =>
    /undefined.*filter|partial\.basket/i.test(
      err instanceof Error ? err.message : String(err),
    ),
}))

vi.mock('./oneSatImportGuard', () => ({
  forgetOneSatImported: vi.fn(),
}))

vi.mock('./actionReview', () => ({
  abortReservedActionBatches: vi.fn(async () => undefined),
}))

vi.mock('./oneSatImport', () => ({
  classifyLegacyUtxos: (...args: unknown[]) => mockClassifyLegacyUtxos(...args),
  importOneSatOrdinals: (...args: unknown[]) => mockImportOneSatOrdinals(...args),
}))

vi.mock('./collectables', () => ({
  clearCollectablesCache: () => mockClearCollectablesCache(),
  invalidateLiveOneSatOutpoints: vi.fn(),
  rememberLiveOneSatOutpoints: vi.fn(),
  listCollectables: vi.fn(async () => []),
}))

vi.mock('./fungibles', () => ({
  listFungibles: vi.fn(async () => []),
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

/** Reset the maintenance batch to a quiet, successful default. */
function resetMaintenanceMocks(): void {
  mockReconcileDualLayerState.mockReset()
  mockHealGhostSentItems.mockReset()
  mockPruneMissingOnChainActivity.mockReset()
  mockExpireStaleInboundPending.mockReset()
  mockRehideInputsOfLiveLocalTxs.mockReset()
  mockRestoreLiveSpendableOutputs.mockReset()

  mockReconcileDualLayerState.mockResolvedValue({
    checked: 0,
    mined: 0,
    failed: 0,
    orphaned: 0,
  })
  mockHealGhostSentItems.mockResolvedValue([])
  mockPruneMissingOnChainActivity.mockResolvedValue(0)
  mockExpireStaleInboundPending.mockReturnValue(0)
  mockRehideInputsOfLiveLocalTxs.mockResolvedValue(undefined)
  mockRestoreLiveSpendableOutputs.mockResolvedValue(0)
}

describe('refreshFromChain pre-scan maintenance', () => {
  beforeEach(() => {
    vi.resetModules()
    resetMaintenanceMocks()
    mockReviewSpendableOutputs.mockReset()
    mockReviewSpendableOutputs.mockResolvedValue({ totalOutputs: 0, outputs: [] })
    mockFetchBalanceSats.mockReset()
    mockFetchBalanceSats.mockResolvedValue(1000)
    mockScanLegacyAddress.mockReset()
    mockScanLegacyAddress.mockResolvedValue({
      address: 'addr',
      chain: 'main',
      sats: 0,
      utxos: [],
      source: 'whatsonchain',
    })
    mockClassifyLegacyUtxos.mockReset()
    mockClassifyLegacyUtxos.mockResolvedValue({
      funding: [],
      oneSats: [],
      bsv21: [],
      heldOneSats: [],
      heldUneconomical: [],
      pendingTips: [],
    })
    mockSetSyncHealth.mockReset()
    mockGetActiveWallet.mockReset()
    mockGetActiveWallet.mockReturnValue({
      chain: 'main',
      wallet: { reviewSpendableOutputs: mockReviewSpendableOutputs },
    })
  })

  it('runs every maintenance step before the address scan', async () => {
    const { refreshFromChain } = await import('./chainIngest')
    await refreshFromChain({ announceReceive: false })

    expect(mockReconcileDualLayerState).toHaveBeenCalledTimes(1)
    expect(mockHealGhostSentItems).toHaveBeenCalledTimes(1)
    expect(mockExpireStaleInboundPending).toHaveBeenCalledTimes(1)
    expect(mockPruneMissingOnChainActivity).toHaveBeenCalledTimes(1)
    expect(mockRehideInputsOfLiveLocalTxs).toHaveBeenCalledTimes(1)
    expect(mockRestoreLiveSpendableOutputs).toHaveBeenCalledTimes(1)
    expect(mockScanLegacyAddress).toHaveBeenCalledTimes(1)
  })

  it('overlaps the independent steps instead of paying for each in turn', async () => {
    let inFlight = 0
    let peak = 0
    const slow = async <T,>(value: T): Promise<T> => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 20))
      inFlight -= 1
      return value
    }
    mockReconcileDualLayerState.mockImplementation(() =>
      slow({ checked: 0, mined: 0, failed: 0, orphaned: 0 }),
    )
    mockHealGhostSentItems.mockImplementation(() => slow([]))
    mockPruneMissingOnChainActivity.mockImplementation(() => slow(0))
    mockRehideInputsOfLiveLocalTxs.mockImplementation(() => slow(undefined))

    const { refreshFromChain } = await import('./chainIngest')
    await refreshFromChain({ announceReceive: false })

    expect(peak).toBeGreaterThan(1)
  })

  it('still scans when one maintenance step throws', async () => {
    mockReconcileDualLayerState.mockRejectedValue(new Error('reconcile exploded'))

    const { refreshFromChain } = await import('./chainIngest')
    const sats = await refreshFromChain({ announceReceive: false })

    expect(sats).toBe(1000)
    // A failure must stay isolated — the rest of the batch and the scan still run.
    expect(mockHealGhostSentItems).toHaveBeenCalledTimes(1)
    expect(mockRestoreLiveSpendableOutputs).toHaveBeenCalledTimes(1)
    expect(mockScanLegacyAddress).toHaveBeenCalledTimes(1)
  })

  it('survives every maintenance step failing at once', async () => {
    mockReconcileDualLayerState.mockRejectedValue(new Error('a'))
    mockHealGhostSentItems.mockRejectedValue(new Error('b'))
    mockPruneMissingOnChainActivity.mockRejectedValue(new Error('c'))
    mockRehideInputsOfLiveLocalTxs.mockRejectedValue(new Error('d'))

    const { refreshFromChain } = await import('./chainIngest')

    await expect(refreshFromChain({ announceReceive: false })).resolves.toBe(1000)
    expect(mockScanLegacyAddress).toHaveBeenCalledTimes(1)
  })

  it('forgets healed tips so they can be re-imported', async () => {
    mockHealGhostSentItems.mockResolvedValue(['aa.0', 'bb.1'])

    const { refreshFromChain } = await import('./chainIngest')
    await refreshFromChain({ announceReceive: false })

    const { forgetOneSatImported } = await import('./oneSatImportGuard')
    expect(forgetOneSatImported).toHaveBeenCalledWith(['aa.0', 'bb.1'])
  })
})

describe('refreshFromChain spendable review', () => {
  beforeEach(() => {
    vi.resetModules()
    resetMaintenanceMocks()
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
      bsv21: [],
      heldOneSats: [],
      heldUneconomical: [],
      pendingTips: [],
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

  it('skips the audit entirely when asked — sends must not pay for it', async () => {
    mockReviewSpendableOutputs.mockResolvedValue({ totalOutputs: 0, outputs: [] })

    const { refreshFromChain } = await import('./chainIngest')
    const sats = await refreshFromChain({ audit: false, announceReceive: false })

    // The audit costs a request per output and only reports, so a spend skips it.
    expect(sats).toBe(1000)
    expect(mockReviewSpendableOutputs).not.toHaveBeenCalled()
    expect(mockScanLegacyAddress).toHaveBeenCalled()
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
      bsv21: [],
      heldOneSats: [],
      heldUneconomical: [],
      pendingTips: [],
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
