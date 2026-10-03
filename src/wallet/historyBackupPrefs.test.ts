import { beforeEach, describe, expect, it, vi } from 'vitest'

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

const mockVault = vi.hoisted(() => ({ identityKey: 'master' as string | null }))
vi.mock('./vault', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./vault')>()),
  readVaultMeta: () => (mockVault.identityKey ? { identityKey: mockVault.identityKey } : null),
}))

import { storageRegistry } from '../storage/registry'
import { accountLocalKey, bindAccountLocalKeyScope } from './accountLocalKeys'
import { durableForgetCached, durableSetItem } from './durableStorage'
import { getHistoryBackupPrefs, setHistoryBackupPrefs } from './historyBackupPrefs'

const primary = () => bindAccountLocalKeyScope({ accountIndex: 0, identityKey: 'master' })
const second = () => bindAccountLocalKeyScope({ accountIndex: 2, identityKey: 'account-two' })

describe('history backup prefs scope', () => {
  beforeEach(() => {
    store.clear()
    durableForgetCached()
    mockVault.identityKey = 'master'
  })

  it('shares the backup host across sub-accounts and keeps upload state per account', () => {
    second()
    setHistoryBackupPrefs({ baseUrl: 'https://backup.example/', lastUploadedAt: 22 })
    primary()
    expect(getHistoryBackupPrefs().baseUrl).toBe('https://backup.example')
    expect(getHistoryBackupPrefs().lastUploadedAt).toBeNull()
    setHistoryBackupPrefs({ lastUploadedAt: 11, highWaterSpendableSats: 500 })

    second()
    const prefs = getHistoryBackupPrefs()
    expect(prefs.baseUrl).toBe('https://backup.example')
    expect(prefs.lastUploadedAt).toBe(22)
    expect(prefs.highWaterSpendableSats).toBeNull()
  })

  it('a host chosen on the primary applies to every sub-account', () => {
    primary()
    setHistoryBackupPrefs({ baseUrl: '' })
    second()
    expect(getHistoryBackupPrefs().baseUrl).toBe('')
  })

  it('lifts a sub-account host saved before backup went vault-wide', () => {
    second()
    durableSetItem(
      accountLocalKey(storageRegistry.historyBackup.key),
      JSON.stringify({ baseUrl: 'https://legacy.example', lastUploadedAt: 5 }),
    )
    setHistoryBackupPrefs({ lastError: null })
    primary()
    expect(getHistoryBackupPrefs().baseUrl).toBe('https://legacy.example')
  })
})
