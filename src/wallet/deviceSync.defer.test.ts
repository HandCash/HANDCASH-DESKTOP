import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A send raises spend priority before it can acquire the region, so a slow chain
 * ingest used to keep the hint true forever and the balance snapshot never left
 * the device. The courtesy has to be budgeted.
 */

let spendWaiting = true

vi.mock('./walletCoordinator', () => ({
  shouldYieldChainIngestToSpend: () => spendWaiting,
  describeSpendPriorityHolds: () => ['runExclusiveSpend (12s)'],
}))

const createBrc39BackupBytes = vi.fn(
  async (_password: string, _opts?: { priority?: string }) => new Uint8Array(1),
)
vi.mock('./historyBackup', () => ({
  createBrc39BackupBytes,
  downloadAndRestoreBrc39Backup: vi.fn(),
  fetchRemoteBrc39Meta: vi.fn(async () => null),
  HistoryThinOverwriteError: class extends Error {},
  uploadBrc39Backup: vi.fn(),
}))

vi.mock('./sessionBackupAuth', () => ({
  getSessionBackupPassword: () => 'session-password',
}))

// No cloud URL — the push writes the local snapshot, which is the same
// historyReplica export the cloud path runs, minus the network.
vi.mock('./historyBackupPrefs', () => ({
  getHistoryBackupPrefs: () => ({}),
  historyBackupObjectUrl: () => 'https://example.invalid/blob',
  resolveHistoryBackupBaseUrl: () => '',
  setHistoryBackupPrefs: vi.fn(),
}))

vi.mock('./backupWatchdog', () => ({
  backupBlockedReason: () => null,
  closeBackupAttempt: vi.fn(),
  openBackupAttempt: vi.fn(),
}))

vi.mock('./permissions', () => ({ hasPendingPermissionPrompt: () => false }))
vi.mock('./appLog', () => ({ appendAppLog: vi.fn() }))

/** Let the scheduler's timer fire and its dynamic imports settle. */
async function runOneWindow(): Promise<void> {
  await vi.advanceTimersByTimeAsync(45_000)
  await vi.advanceTimersByTimeAsync(0)
}

describe('scheduleHistoryBackupPush deferral budget', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    createBrc39BackupBytes.mockClear()
    spendWaiting = true
    const { resetHistoryBackupDeferForTests } = await import('./deviceSync')
    resetHistoryBackupDeferForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('uploads as starved once the budget is spent, even with a spend still waiting', async () => {
    const { scheduleHistoryBackupPush } = await import('./deviceSync')
    scheduleHistoryBackupPush('send')

    // Four windows of courtesy — the export must not run while budget remains.
    for (let i = 0; i < 4; i += 1) {
      await runOneWindow()
      expect(createBrc39BackupBytes).not.toHaveBeenCalled()
    }

    await runOneWindow()

    expect(createBrc39BackupBytes).toHaveBeenCalledTimes(1)
    expect(createBrc39BackupBytes.mock.calls[0]?.[1]).toMatchObject({
      priority: 'starved',
    })
  })

  it('keeps yielding while the budget lasts and pushes normally once spend clears', async () => {
    const { scheduleHistoryBackupPush } = await import('./deviceSync')
    scheduleHistoryBackupPush('send')

    await runOneWindow()
    expect(createBrc39BackupBytes).not.toHaveBeenCalled()

    spendWaiting = false
    await runOneWindow()

    expect(createBrc39BackupBytes).toHaveBeenCalledTimes(1)
    expect(createBrc39BackupBytes.mock.calls[0]?.[1]).toMatchObject({
      priority: 'yieldToSpend',
    })
  })
})
