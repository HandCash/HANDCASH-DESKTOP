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

vi.mock('./vault', () => ({
  readVaultUnlockFactors: () => ({ password: true, device: false }),
}))

import {
  clearOpenUnlockSecret,
  generateWrapSecret,
  getDeviceLockMode,
  getOpenUnlockSecret,
  hasMemorablePassword,
  isNoDeviceLock,
  setDeviceLockMode,
  setOpenUnlockSecret,
  shouldAutoUnlock,
} from './deviceLockPrefs'

describe('deviceLockPrefs', () => {
  beforeEach(async () => {
    store.clear()
    const { durableForgetCached } = await import('./durableStorage')
    durableForgetCached()
    clearOpenUnlockSecret()
  })

  it('stores none + open secret for auto-unlock', () => {
    expect(getDeviceLockMode()).toBeNull()
    expect(shouldAutoUnlock()).toBe(false)
    setOpenUnlockSecret('Hc1secretsecret1')
    setDeviceLockMode('none')
    expect(getDeviceLockMode()).toBe('none')
    expect(getOpenUnlockSecret()).toBe('Hc1secretsecret1')
    expect(isNoDeviceLock()).toBe(true)
    expect(shouldAutoUnlock()).toBe(true)
    expect(hasMemorablePassword()).toBe(false)
  })

  it('device-only and open-unlock are not memorable passwords', () => {
    setDeviceLockMode('device')
    expect(hasMemorablePassword()).toBe(false)
    setDeviceLockMode('password')
    expect(hasMemorablePassword()).toBe(true)
    setDeviceLockMode('both')
    expect(hasMemorablePassword()).toBe(true)
  })

  it('generateWrapSecret meets password policy shape', async () => {
    const { validatePassword } = await import('./passwordPolicy')
    const secret = generateWrapSecret()
    expect(validatePassword(secret)).toBeNull()
  })
})
