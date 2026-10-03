import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bindAccountLocalKeyScope } from './accountLocalKeys'

const store = new Map<string, string>()

vi.stubGlobal('localStorage', {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => {
    store.set(key, value)
  },
  removeItem: (key: string) => {
    store.delete(key)
  },
})

vi.stubGlobal('window', { handcash: undefined })

const mockVault = vi.hoisted(() => ({ identityKey: null as string | null }))
vi.mock('./vault', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./vault')>()),
  readVaultMeta: () => (mockVault.identityKey ? { identityKey: mockVault.identityKey } : null),
}))

import { storageRegistry } from '../storage/registry'
import { accountLocalKey } from './accountLocalKeys'
import { durableSetItem } from './durableStorage'
import {
  canConfirmHistoryBackup,
  canConfirmKeysBackup,
  clearBackupConfirmed,
  isBackupConfirmed,
  isKeysBackupConfirmed,
  markHistoryBackupConfirmed,
  isKeysBackupDeferred,
  markKeysBackupConfirmed,
  markKeysBackupDeferred,
  noteHistoryBackupExport,
  noteKeysBackupHandoff,
  rebindBackupStatusForAccount,
} from './backupStatus'

describe('backupStatus evidence gates', () => {
  beforeEach(async () => {
    mockVault.identityKey = null
    store.clear()
    // Clearing the backing map behind durableStorage bypasses its read cache.
    const { durableForgetCached } = await import('./durableStorage')
    durableForgetCached()
    clearBackupConfirmed()
  })

  it('requires two distinct manual slice confirmations before keys confirm', () => {
    expect(canConfirmKeysBackup('split')).toBe(false)
    expect(markKeysBackupConfirmed('split')).toBe(false)

    noteKeysBackupHandoff(0)
    expect(canConfirmKeysBackup('split')).toBe(false)

    noteKeysBackupHandoff(0)
    expect(canConfirmKeysBackup('split')).toBe(false)

    noteKeysBackupHandoff(1)
    expect(canConfirmKeysBackup('split')).toBe(true)
    expect(markKeysBackupConfirmed('split')).toBe(true)
  })

  it('clearKeysHandoffEvidence resets split progress after rotate', async () => {
    const { clearKeysHandoffEvidence, getKeysSplitHandoffProgress } = await import('./backupStatus')
    noteKeysBackupHandoff(0)
    noteKeysBackupHandoff(1)
    expect(canConfirmKeysBackup('split')).toBe(true)
    clearKeysHandoffEvidence()
    expect(canConfirmKeysBackup('split')).toBe(false)
    expect(getKeysSplitHandoffProgress().saved).toBe(0)
  })

  it('phrase/key confirm needs a single handoff without slice index', () => {
    expect(canConfirmKeysBackup('phrase')).toBe(false)
    noteKeysBackupHandoff()
    expect(canConfirmKeysBackup('phrase')).toBe(true)
    expect(canConfirmKeysBackup('key')).toBe(true)
  })

  it('requires history export before history confirm', () => {
    expect(canConfirmHistoryBackup()).toBe(false)
    expect(markHistoryBackupConfirmed()).toBe(false)

    noteHistoryBackupExport()
    expect(canConfirmHistoryBackup()).toBe(true)
    expect(markHistoryBackupConfirmed()).toBe(true)
  })

  it('isBackupConfirmed only when both steps are done', () => {
    noteKeysBackupHandoff()
    markKeysBackupConfirmed('key')
    expect(isBackupConfirmed()).toBe(false)

    noteHistoryBackupExport()
    markHistoryBackupConfirmed()
    expect(isBackupConfirmed()).toBe(true)
  })

  it('defers keys backup without confirming', () => {
    expect(isKeysBackupDeferred()).toBe(false)
    markKeysBackupDeferred()
    expect(isKeysBackupDeferred()).toBe(true)
    noteKeysBackupHandoff()
    expect(markKeysBackupConfirmed('phrase')).toBe(true)
    expect(isKeysBackupDeferred()).toBe(false)
  })

  it('keeps backup policy and session evidence across sub-accounts of one vault', () => {
    mockVault.identityKey = 'master'
    bindAccountLocalKeyScope({ accountIndex: 0, identityKey: 'master' })
    rebindBackupStatusForAccount()
    noteKeysBackupHandoff()
    expect(markKeysBackupConfirmed('phrase')).toBe(true)
    noteHistoryBackupExport()
    expect(markHistoryBackupConfirmed()).toBe(true)

    bindAccountLocalKeyScope({ accountIndex: 2, identityKey: 'account-two' })
    rebindBackupStatusForAccount()
    expect(isBackupConfirmed()).toBe(true)
    expect(canConfirmKeysBackup('phrase')).toBe(true)
    expect(canConfirmHistoryBackup()).toBe(true)
  })

  it('starts over for a different vault', () => {
    mockVault.identityKey = 'master'
    bindAccountLocalKeyScope({ accountIndex: 0, identityKey: 'master' })
    rebindBackupStatusForAccount()
    noteKeysBackupHandoff()
    markKeysBackupConfirmed('phrase')

    mockVault.identityKey = 'other-master'
    bindAccountLocalKeyScope({ accountIndex: 0, identityKey: 'other-master' })
    rebindBackupStatusForAccount()
    expect(isKeysBackupConfirmed()).toBe(false)
    expect(canConfirmKeysBackup('phrase')).toBe(false)
    expect(isKeysBackupDeferred()).toBe(false)
  })

  it('promotes a history confirmation recorded on one sub-account to the vault', () => {
    mockVault.identityKey = 'master'
    bindAccountLocalKeyScope({ accountIndex: 1, identityKey: 'account-one' })
    durableSetItem(accountLocalKey(storageRegistry.historyBackupConfirmed.key), '1')
    noteKeysBackupHandoff()
    markKeysBackupConfirmed('phrase')
    expect(isBackupConfirmed()).toBe(true)

    bindAccountLocalKeyScope({ accountIndex: 3, identityKey: 'account-three' })
    expect(isBackupConfirmed()).toBe(true)
  })
})
