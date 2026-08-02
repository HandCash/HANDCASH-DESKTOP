import { safeStorage, systemPreferences } from 'electron'
import log from 'electron-log'
import { durableGet, durableRemove, durableSet } from './durableStore.js'

export const DEVICE_UNLOCK_KEY = 'handcash.brc100.deviceUnlock.v1'

export type DeviceAuthStatus = {
  available: boolean
  enrolled: boolean
  label: string
}

function platformLabel(): string {
  if (process.platform === 'darwin') return 'Touch ID'
  if (process.platform === 'win32') return 'Windows Hello'
  return 'Device unlock'
}

export function deviceAuthStatus(): DeviceAuthStatus {
  const label = platformLabel()
  let available = false
  try {
    if (process.platform === 'darwin') {
      available =
        typeof systemPreferences.canPromptTouchID === 'function' &&
        systemPreferences.canPromptTouchID() &&
        safeStorage.isEncryptionAvailable()
    }
  } catch (err) {
    log.warn('deviceAuth availability check failed', err)
  }
  const enrolled = available && Boolean(durableGet(DEVICE_UNLOCK_KEY))
  return { available, enrolled, label }
}

export function deviceAuthEnroll(password: string): { ok: true } | { ok: false; error: string } {
  if (typeof password !== 'string' || password.length < 1) {
    return { ok: false, error: 'Password required' }
  }
  const status = deviceAuthStatus()
  if (!status.available) {
    return { ok: false, error: `${status.label} is not available on this device` }
  }
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: 'OS secure storage is unavailable' }
    }
    // Store plaintext password; durableStore seals deviceUnlock keys with safeStorage.
    const ok = durableSet(DEVICE_UNLOCK_KEY, password)
    if (!ok) return { ok: false, error: 'Could not save device unlock credential' }
    return { ok: true }
  } catch (err) {
    log.warn('deviceAuth enroll failed', err)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function deviceAuthUnlock(
  reason = 'Unlock HandCash',
): Promise<{ ok: true; password: string } | { ok: false; error: string }> {
  const status = deviceAuthStatus()
  if (!status.available) {
    return { ok: false, error: `${status.label} is not available` }
  }
  if (!status.enrolled) {
    return { ok: false, error: `${status.label} is not enabled` }
  }
  try {
    if (process.platform === 'darwin' && typeof systemPreferences.promptTouchID === 'function') {
      await systemPreferences.promptTouchID(reason)
    } else {
      return { ok: false, error: `${status.label} prompt is not supported` }
    }
    const password = durableGet(DEVICE_UNLOCK_KEY)
    if (!password) {
      return { ok: false, error: 'Device unlock credential missing — use your password' }
    }
    return { ok: true, password }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // User cancel is common — keep it soft.
    if (/cancel|denied|user/i.test(message)) {
      return { ok: false, error: 'cancelled' }
    }
    log.warn('deviceAuth unlock failed', err)
    return { ok: false, error: message }
  }
}

export function deviceAuthClear(): { ok: true } {
  durableRemove(DEVICE_UNLOCK_KEY)
  return { ok: true }
}
