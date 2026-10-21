import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  markBackupFormatSaved,
  openBackupFormat,
  savedBackupFormats,
  takeRequestedBackupFormat,
} from './backupFormats'
import { openSetting } from './navStore'

const store = new Map<string, string>()
vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => void store.set(key, value),
}))
vi.mock('./vaultLocalKeys', () => ({ vaultLocalKey: (key: string) => `vault-a:${key}` }))
vi.mock('./navStore', () => ({ openSetting: vi.fn() }))

beforeEach(() => {
  store.clear()
  vi.mocked(openSetting).mockClear()
  takeRequestedBackupFormat()
})

describe('self-kept backups', () => {
  it.each(['phrase', 'split', 'key'] as const)('%s opens Recovery backup on its own tab, once', (format) => {
    openBackupFormat(format)
    expect(openSetting).toHaveBeenCalledWith('backup')
    expect(takeRequestedBackupFormat()).toBe(format)
    expect(takeRequestedBackupFormat()).toBeNull()
  })

  it('tracks each saved format on its own', () => {
    expect([...savedBackupFormats()]).toEqual([])
    markBackupFormatSaved('key')
    markBackupFormatSaved('phrase')
    markBackupFormatSaved('key')
    expect([...savedBackupFormats()].sort()).toEqual(['key', 'phrase'])
  })
})
