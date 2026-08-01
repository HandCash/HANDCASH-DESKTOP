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
  canConfirmHistoryBackup,
  canConfirmKeysBackup,
  clearBackupConfirmed,
  isBackupConfirmed,
  markHistoryBackupConfirmed,
  markKeysBackupConfirmed,
  noteHistoryBackupExport,
  noteKeysBackupHandoff,
} from './backupStatus'

describe('backupStatus evidence gates', () => {
  beforeEach(() => {
    store.clear()
    clearBackupConfirmed()
  })

  it('requires handoffs before keys confirm (split needs 2)', () => {
    expect(canConfirmKeysBackup('split')).toBe(false)
    expect(markKeysBackupConfirmed('split')).toBe(false)

    noteKeysBackupHandoff()
    expect(canConfirmKeysBackup('split')).toBe(false)
    expect(canConfirmKeysBackup('phrase')).toBe(true)

    noteKeysBackupHandoff()
    expect(canConfirmKeysBackup('split')).toBe(true)
    expect(markKeysBackupConfirmed('split')).toBe(true)
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
})
