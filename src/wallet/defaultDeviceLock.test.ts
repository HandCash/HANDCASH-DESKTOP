import { afterEach, describe, expect, it, vi } from 'vitest'

const enableDeviceUnlock = vi.fn(async () => {})
const setDeviceLockMode = vi.fn()
const setOpenUnlockSecret = vi.fn()

vi.mock('./vault', () => ({
  changeVaultPassword: vi.fn(async () => {}),
  enableDeviceUnlock: (secret: string) => enableDeviceUnlock(secret),
}))

vi.mock('./deviceLockPrefs', () => ({
  clearOpenUnlockSecret: vi.fn(),
  setDeviceLockMode: (mode: string) => setDeviceLockMode(mode),
  setOpenUnlockSecret: (secret: string) => setOpenUnlockSecret(secret),
}))

import { applyJoinedDeviceLock } from './applyOnboardLock'
import { osKeyStorageAvailable, protectChoice } from './defaultDeviceLock'

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('default device lock', () => {
  it('starts on device unlock where the OS can ask for presence', () => {
    expect(protectChoice({ deviceAvailable: true, osKeyStorage: true }).defaultMode).toBe('device')
  })

  it('starts on a password on Windows, Linux and Macs without Touch ID, never on no lock', () => {
    expect(protectChoice({ deviceAvailable: false, osKeyStorage: true }).defaultMode).toBe('password')
    expect(protectChoice({ deviceAvailable: false, osKeyStorage: false }).defaultMode).toBe('password')
  })

  it('offers no lock only where an OS key store seals the unlock secret', () => {
    expect(protectChoice({ deviceAvailable: false, osKeyStorage: true }).noneAllowed).toBe(true)
    expect(protectChoice({ deviceAvailable: false, osKeyStorage: false }).noneAllowed).toBe(false)
  })

  it('reads the OS key store from the bridge, and counts a missing or failing bridge as none', async () => {
    vi.stubGlobal('window', { handcash: { safeStorageAvailable: async () => true } })
    expect(await osKeyStorageAvailable()).toBe(true)
    vi.stubGlobal('window', { handcash: { safeStorageAvailable: async () => false } })
    expect(await osKeyStorageAvailable()).toBe(false)
    vi.stubGlobal('window', { handcash: { safeStorageAvailable: async () => { throw new Error('ipc') } } })
    expect(await osKeyStorageAvailable()).toBe(false)
    vi.stubGlobal('window', { handcash: undefined })
    expect(await osKeyStorageAvailable()).toBe(false)
  })
})

describe('joined device lock', () => {
  it('takes device unlock without asking where it is available', async () => {
    const lock = await applyJoinedDeviceLock('wrap', true)
    expect(lock).toEqual({ sessionPassword: 'wrap', mode: 'device' })
    expect(setDeviceLockMode).toHaveBeenCalledWith('device')
  })

  it('asks the holder when device unlock is not available, setting no lock itself', async () => {
    expect(await applyJoinedDeviceLock('wrap', false)).toBeNull()
    expect(setDeviceLockMode).not.toHaveBeenCalled()
    expect(setOpenUnlockSecret).not.toHaveBeenCalled()
  })

  it('asks the holder when the device prompt fails, never falling back to no lock', async () => {
    enableDeviceUnlock.mockRejectedValueOnce(new Error('cancelled'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await applyJoinedDeviceLock('wrap', true)).toBeNull()
    expect(setDeviceLockMode).not.toHaveBeenCalledWith('none')
  })
})
