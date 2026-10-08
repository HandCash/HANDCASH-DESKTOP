import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  autoPush: vi.fn(),
  hasBackupUrl: vi.fn(),
  inspectState: vi.fn(),
  noteHighWater: vi.fn(),
  refresh: vi.fn(),
  refreshShared: vi.fn(),
  relist: vi.fn(),
  inRegion: false,
}))

vi.mock('./collectables', () => ({
  relistCollectablesAfterLocalStateReplace: mocks.relist,
}))

vi.mock('./chainIngest', () => ({
  refreshFromChain: mocks.refreshShared,
  refreshFromChainExclusive: mocks.refresh,
}))

vi.mock('./walletCoordinator', () => ({
  isRecomposeCoordinatorActive: () => false,
  runRecompose: async <T>(fn: () => Promise<T>) => {
    mocks.inRegion = true
    try {
      return await fn()
    } finally {
      mocks.inRegion = false
    }
  },
  shouldYieldChainIngestToSpend: () => false,
}))

vi.mock('./deviceSync', () => ({
  autoPushHistoryBackupIfConfigured: mocks.autoPush,
  hasDeviceLinkBackupUrl: mocks.hasBackupUrl,
}))

vi.mock('./sessionBackupAuth', () => ({
  getSessionBackupPassword: () => null,
  sessionBackupCredential: () => null,
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

const FUNDING_PASS = {
  forceReview: false,
  announceReceive: false,
  audit: false,
  fundingOnly: true,
}

describe('recomposeWallet', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.inRegion = false
    mocks.hasBackupUrl.mockReturnValue(false)
    mocks.refresh.mockResolvedValue({
      balanceSats: 0,
      importedFunding: 0,
      importedItems: 0,
      scannedTxids: [],
    })
    mocks.refreshShared.mockResolvedValue(0)
    mocks.autoPush.mockResolvedValue({
      pulled: false,
      skipReason: null,
      pullError: null,
    })
  })

  it('keeps unlock recompose on the funding-only critical path', async () => {
    const { recomposeWallet } = await import('./recompose')

    await recomposeWallet({ reason: 'unlock' })

    expect(mocks.refreshShared).toHaveBeenCalledWith(FUNDING_PASS)
    expect(mocks.refresh).not.toHaveBeenCalled()
    expect(mocks.relist).not.toHaveBeenCalled()
  })

  it('runs an unchanged wallet’s funding pass outside the recompose region', async () => {
    let fencedDuringChain: boolean | null = null
    mocks.refreshShared.mockImplementation(async () => {
      fencedDuringChain = mocks.inRegion
      return 0
    })
    const { recomposeWallet } = await import('./recompose')

    await recomposeWallet({ reason: 'unlock' })

    expect(fencedDuringChain).toBe(false)
  })

  it('keeps chain and relist fenced after cloud history replaced local state', async () => {
    mocks.hasBackupUrl.mockReturnValue(true)
    mocks.autoPush.mockResolvedValue({ pulled: true, skipReason: null, pullError: null })
    let fencedDuringChain: boolean | null = null
    let fencedDuringRelist: boolean | null = null
    mocks.refresh.mockImplementation(async () => {
      fencedDuringChain = mocks.inRegion
      return { balanceSats: 0, importedFunding: 0, importedItems: 0, scannedTxids: [] }
    })
    mocks.relist.mockImplementation(async () => {
      fencedDuringRelist = mocks.inRegion
    })
    const { recomposeWallet } = await import('./recompose')

    await recomposeWallet({ password: 'test-password', reason: 'unlock' })

    expect(mocks.refresh).toHaveBeenCalledWith(FUNDING_PASS)
    expect(mocks.refreshShared).not.toHaveBeenCalled()
    expect(fencedDuringChain).toBe(true)
    expect(fencedDuringRelist).toBe(true)
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
    mocks.refreshShared.mockResolvedValue(9000)
    const { recomposeWallet } = await import('./recompose')

    await recomposeWallet({ reason: 'unlock' })

    expect(mocks.noteHighWater).toHaveBeenCalledWith(9000, 7)
    expect(mocks.inspectState).not.toHaveBeenCalled()
  })
})
