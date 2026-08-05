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

  it('requires handoffs before keys confirm (split needs 2 distinct slices)', () => {
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
})
