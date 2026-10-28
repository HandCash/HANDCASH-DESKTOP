import { beforeEach, describe, expect, it, vi } from 'vitest'
import { storageRegistry } from '../storage/registry'
import type { LegacyGoogleEnrollment } from './legacyGoogleRecovery'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (k: string) => store.get(k) ?? null,
  durableSetItem: (k: string, v: string) => {
    store.set(k, v)
    return true
  },
}))

vi.mock('./vaultLocalKeys', () => ({ vaultLocalKey: (base: string) => base }))

const KEY = storageRegistry.emailRecovery.key

const saved: LegacyGoogleEnrollment = {
  v: 1,
  host: 'https://brc250-google.example',
  email: 'ann@gmail.com',
  authorityKey: '02aa',
  attesterKey: '02bb',
  master: { derivation: 'brc-42' },
  mailboxConfirmed: true,
  enrolledAt: 1,
}

describe('saved Google recovery enrollments', () => {
  beforeEach(() => store.clear())

  it('still reads a record saved by the retired setup, under its original key', async () => {
    store.set('handcash.brc250.emailRecovery.v1', JSON.stringify(saved))
    expect(KEY).toBe('handcash.brc250.emailRecovery.v1')
    const { getLegacyGoogleEnrollment } = await import('./legacyGoogleRecovery')
    expect(getLegacyGoogleEnrollment()).toEqual(saved)
  })

  it('reads nothing from a missing, cleared, corrupt or unknown-version record', async () => {
    const { getLegacyGoogleEnrollment, setLegacyGoogleEnrollment } = await import('./legacyGoogleRecovery')
    expect(getLegacyGoogleEnrollment()).toBeNull()
    setLegacyGoogleEnrollment(saved)
    setLegacyGoogleEnrollment(null)
    expect(getLegacyGoogleEnrollment()).toBeNull()
    store.set(KEY, '{not json')
    expect(getLegacyGoogleEnrollment()).toBeNull()
    store.set(KEY, JSON.stringify({ ...saved, v: 2 }))
    expect(getLegacyGoogleEnrollment()).toBeNull()
  })
})
