import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  autoPush: vi.fn(),
  hasBackupUrl: vi.fn(),
  inspectState: vi.fn(),
  noteHighWater: vi.fn(),
  refresh: vi.fn(),
  relist: vi.fn(),
}))

vi.mock('./collectables', () => ({
  relistCollectablesAfterLocalStateReplace: mocks.relist,
}))

vi.mock('./chainIngest', () => ({
  refreshFromChainExclusive: mocks.refresh,
}))

vi.mock('./walletCoordinator', () => ({
  isRecomposeCoordinatorActive: () => false,
  runRecompose: <T>(fn: () => Promise<T>) => fn(),
  shouldYieldChainIngestToSpend: () => false,
}))

vi.mock('./deviceSync', () => ({
  autoPushHistoryBackupIfConfigured: mocks.autoPush,
  hasDeviceLinkBackupUrl: mocks.hasBackupUrl,
}))

vi.mock('./sessionBackupAuth', () => ({
  getSessionBackupPassword: () => null,
  setSessionBackupPassword: vi.fn(),
}))

vi.mock('./session', () => ({
  fetchBalanceSats: vi.fn(),
  getActiveWallet: () => null,
}))

vi.mock('./layers', () => ({
  inspectLocalToolboxState: mocks.inspectState,
}))

vi.mock('./historyBackupPrefs', () => ({
  getHistoryBackupPrefs: () => ({ highWaterActionCount: 7 }),
  noteSpendableHighWater: mocks.noteHighWater,
}))

describe('recomposeWallet', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.hasBackupUrl.mockReturnValue(false)
    mocks.refresh.mockResolvedValue({
      balanceSats: 0,
      importedFunding: 0,
      importedItems: 0,
      scannedTxids: [],
    })
    mocks.autoPush.mockResolvedValue({
      pulled: false,
      skipReason: null,
      pullError: null,
    })
  })

  it('keeps unlock recompose on the funding-only critical path', async () => {
    const { recomposeWallet } = await import('./recompose')

    await recomposeWallet({ reason: 'unlock' })

    expect(mocks.refresh).toHaveBeenCalledWith({
      forceReview: false,
      announceReceive: false,
      audit: false,
      fundingOnly: true,
    })
    expect(mocks.relist).not.toHaveBeenCalled()
  })

  it('re-lists collectables after a caller already replaced local state', async () => {
    const { recomposeWallet } = await import('./recompose')

    await recomposeWallet({ history: 'skip', chain: false })

    expect(mocks.relist).toHaveBeenCalledOnce()
  })

  it('re-lists collectables after cloud history was pulled', async () => {
    mocks.hasBackupUrl.mockReturnValue(true)
    mocks.autoPush.mockResolvedValue({
      pulled: true,
      skipReason: null,
      pullError: null,
    })
    const { recomposeWallet } = await import('./recompose')

    await recomposeWallet({ password: 'test-password', chain: false })

    expect(mocks.relist).toHaveBeenCalledOnce()
  })

  it('updates the balance high-water without rescanning Toolbox state', async () => {
    mocks.refresh.mockResolvedValue({
      balanceSats: 9000,
      importedFunding: 0,
      importedItems: 0,
      scannedTxids: [],
    })
    const { recomposeWallet } = await import('./recompose')

    await recomposeWallet({ reason: 'unlock' })

    expect(mocks.noteHighWater).toHaveBeenCalledWith(9000, 7)
    expect(mocks.inspectState).not.toHaveBeenCalled()
  })
})
