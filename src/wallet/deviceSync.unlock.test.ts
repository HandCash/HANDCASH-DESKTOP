import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Unlock hands its upload to the debounced push. That push used to carry the
 * same `unlock` reason, defer itself again, and never upload — re-reading every
 * Toolbox basket each minute while it did.
 */

const remote = { exists: true, exportedAt: 1, bytes: 50_000, spendableSats: 900, actionCount: 40 }
const local = { spendableSats: 900, defaultOutputCount: 3, actionCount: 40, looksEmpty: false }

const uploadBrc39Backup = vi.fn(async () => ({ url: 'u', exportedAt: 2, spendableSats: 0, actionCount: 0 }))
const inspectLocalToolboxState = vi.fn(async () => local)
const localToolboxStateLooksEmpty = vi.fn(async () => false)

vi.mock('./historyBackup', () => ({
  createBrc39BackupBytes: vi.fn(),
  downloadAndRestoreBrc39Backup: vi.fn(),
  replaceLocalHistoryFromCloud: vi.fn(),
  fetchRemoteBrc39Meta: vi.fn(async () => remote),
  HistoryThinOverwriteError: class extends Error {},
  uploadBrc39Backup: () => uploadBrc39Backup(),
}))
vi.mock('./layers', () => ({
  inspectLocalToolboxState: () => inspectLocalToolboxState(),
  localToolboxStateLooksEmpty: () => localToolboxStateLooksEmpty(),
}))
vi.mock('./walletCoordinator', () => ({
  shouldYieldChainIngestToSpend: () => false,
  describeSpendPriorityHolds: () => [],
}))
vi.mock('./sessionBackupAuth', () => ({
  getSessionBackupPassword: () => 'pw',
  sessionBackupCredential: () => 'pw',
}))
vi.mock('./historyBackupPrefs', () => ({
  getHistoryBackupPrefs: () => ({}),
  historyBackupObjectUrl: () => 'https://example.invalid/blob',
  resolveHistoryBackupBaseUrl: () => 'https://example.invalid',
  setHistoryBackupPrefs: vi.fn(),
}))
vi.mock('./cloudBackupHealth', () => ({ ensureHistoryBackupUrlFromConfig: vi.fn() }))
vi.mock('./backupWatchdog', () => ({
  backupBlockedReason: () => null,
  closeBackupAttempt: vi.fn(),
  openBackupAttempt: vi.fn(),
}))
vi.mock('./permissions', () => ({
  hasPendingPermissionPrompt: () => false,
  hasInboundWalletRequest: () => false,
}))
vi.mock('./session', () => ({ getActiveWallet: () => null }))
vi.mock('./appLog', () => ({ appendAppLog: vi.fn() }))

describe('unlock history push', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    uploadBrc39Backup.mockClear()
    inspectLocalToolboxState.mockClear()
    localToolboxStateLooksEmpty.mockClear()
    remote.actionCount = 40
    const { rebindDeviceSyncForAccount } = await import('./deviceSync')
    rebindDeviceSyncForAccount()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('defers on the unlock path after one cheap empty probe, without reading baskets for the gate', async () => {
    const { autoPushHistoryBackupIfConfigured } = await import('./deviceSync')
    const result = await autoPushHistoryBackupIfConfigured('pw', { reason: 'unlock' })
    expect(result).toEqual({ pulled: false, pullError: null, skipReason: null })
    expect(localToolboxStateLooksEmpty).toHaveBeenCalledOnce()
    expect(inspectLocalToolboxState).not.toHaveBeenCalled()
    expect(uploadBrc39Backup).not.toHaveBeenCalled()
    const { fetchRemoteBrc39Meta } = await import('./historyBackup')
    expect(fetchRemoteBrc39Meta).not.toHaveBeenCalled()
  })

  it('the deferred push uploads when the remote copy is behind', async () => {
    remote.actionCount = 39
    const { autoPushHistoryBackupIfConfigured } = await import('./deviceSync')
    await autoPushHistoryBackupIfConfigured('pw', { reason: 'unlock' })
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(uploadBrc39Backup).toHaveBeenCalledOnce()
  })

  it('the deferred push skips the upload when the remote already holds this wallet', async () => {
    const { autoPushHistoryBackupIfConfigured } = await import('./deviceSync')
    await autoPushHistoryBackupIfConfigured('pw', { reason: 'unlock' })
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(inspectLocalToolboxState).toHaveBeenCalledOnce()
    expect(uploadBrc39Backup).not.toHaveBeenCalled()
    // And it does not hand itself on again.
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(inspectLocalToolboxState).toHaveBeenCalledOnce()
  })
})
