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

import {
  DEFAULT_BACKUP_SERVICE_URLS,
  addBackupServiceUrl,
  getBackupServicePrefs,
  removeBackupServiceUrl,
} from './backupServicePrefs'

describe('backupServicePrefs', () => {
  beforeEach(() => {
    store.clear()
  })

  it('ships with an empty curated URL list', () => {
    expect(DEFAULT_BACKUP_SERVICE_URLS).toEqual([])
    expect(getBackupServicePrefs().urls).toEqual([])
  })

  it('adds and removes user-configured URLs', () => {
    addBackupServiceUrl('http://127.0.0.1:8787/')
    expect(getBackupServicePrefs().urls).toEqual(['http://127.0.0.1:8787'])
    removeBackupServiceUrl('http://127.0.0.1:8787')
    expect(getBackupServicePrefs().urls).toEqual([])
  })
})
