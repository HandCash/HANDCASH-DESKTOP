import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
  },
}))

const T0 = 1_700_000_000_000

async function load() {
  return import('./backupWatchdog')
}

describe('backupWatchdog', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
  })

  it('allows a backup on a fresh install', async () => {
    const wd = await load()
    expect(wd.backupBlockedReason(T0)).toBeNull()
    expect(wd.reconcileBackupWatchdog(T0)).toBeNull()
  })

  it('blocks while an attempt is open', async () => {
    const wd = await load()
    wd.openBackupAttempt(T0)
    expect(wd.backupBlockedReason(T0)).toMatch(/already open/)
  })

  it('a successful attempt leaves the next one unblocked', async () => {
    const wd = await load()
    wd.openBackupAttempt(T0)
    wd.closeBackupAttempt(true, T0 + 1_000)
    expect(wd.backupBlockedReason(T0 + 2_000)).toBeNull()
    expect(wd.getBackupWatchdogState().lastSuccessAt).toBe(T0 + 1_000)
  })

  it('an attempt that never closed is recovered as a failure at boot', async () => {
    const wd = await load()
    wd.openBackupAttempt(T0)

    // Simulate the process dying inside Argon2id: the open marker survives.
    vi.resetModules()
    const next = await load()
    expect(next.reconcileBackupWatchdog(T0 + 10_000)).toMatch(/never finished \(attempt 1\)/)
    expect(next.backupBlockedReason(T0 + 10_000)).toMatch(/backing off after 1/)
  })

  it('backs off further on each consecutive crash, ending the loop', async () => {
    const wd = await load()
    let now = T0
    const waits: number[] = []

    // First pass is a clean boot, so it contributes no wait.
    for (let i = 0; i < 5; i++) {
      // Boot, wait out the previous hold, start a backup, die inside it.
      wd.reconcileBackupWatchdog(now)
      const blockedUntil = wd.getBackupWatchdogState().blockedUntil
      if (blockedUntil != null) {
        waits.push(blockedUntil - now)
        now = blockedUntil
      }
      expect(wd.backupBlockedReason(now)).toBeNull()
      wd.openBackupAttempt(now)
      now += 3_000
    }

    expect(waits).toEqual([5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 12 * 60 * 60_000])
  })

  it('clears the hold once a retry finally succeeds', async () => {
    const wd = await load()
    wd.openBackupAttempt(T0)
    wd.reconcileBackupWatchdog(T0 + 1_000)
    expect(wd.backupBlockedReason(T0 + 1_000)).not.toBeNull()

    const after = T0 + 60 * 60_000
    wd.openBackupAttempt(after)
    wd.closeBackupAttempt(true, after + 5_000)
    expect(wd.backupBlockedReason(after + 5_000)).toBeNull()
    expect(wd.getBackupWatchdogState().consecutiveFailures).toBe(0)
  })

  it('a manual backup is never blocked by an earlier crash', async () => {
    const wd = await load()
    wd.openBackupAttempt(T0)
    wd.reconcileBackupWatchdog(T0 + 1_000)
    expect(wd.backupBlockedReason(T0 + 1_000)).not.toBeNull()

    wd.clearBackupBackoff()
    expect(wd.backupBlockedReason(T0 + 1_000)).toBeNull()
  })

  it('survives a corrupt record', async () => {
    store.set('handcash.cloudBackup.watchdog.v1', '{not json')
    const wd = await load()
    expect(wd.backupBlockedReason(T0)).toBeNull()
  })
})
