/**
 * Desktop device-unlock factor: DEK sealed with Electron safeStorage (OS
 * keychain / DPAPI), gated by Touch ID when the Mac can prompt for it.
 *
 * This is independent of the in-app password wrap in vault.ts.
 */
import { safeStorage, systemPreferences } from 'electron'
import log from 'electron-log'
import { durableGet, durableSet } from './durableStore.js'

const DEVICE_DEK_KEY = 'handcash.brc100.deviceDek.v1'
const SEALED_PREFIX = 'sealed:v1:'

function canSeal(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

function platformLabel(): string {
  if (process.platform === 'darwin') {
    try {
      if (systemPreferences.canPromptTouchID()) return 'Touch ID'
    } catch {
      // ignore
    }
    return 'Mac password'
  }
  if (process.platform === 'win32') return 'Windows Hello'
  return 'Device unlock'
}

async function promptPresence(reason: string): Promise<void> {
  if (process.platform !== 'darwin') return
  try {
    if (!systemPreferences.canPromptTouchID()) return
    await systemPreferences.promptTouchID(reason)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/cancel|denied|user/i.test(message)) throw new Error('cancelled')
    throw new Error(message || 'Touch ID failed')
  }
}

export function deviceAuthStatus(): {
  available: boolean
  enrolled: boolean
  label: string
  strongBox?: boolean
} {
  const available = canSeal()
  const enrolled = available && Boolean(durableGet(DEVICE_DEK_KEY))
  return {
    available,
    enrolled,
    label: platformLabel(),
    strongBox: process.platform === 'darwin',
  }
}

export async function deviceAuthEnroll(
  secret: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (typeof secret !== 'string' || !secret) {
    return { ok: false, error: 'Unlock material required' }
  }
  if (!canSeal()) {
    return { ok: false, error: 'OS keychain sealing is not available on this device' }
  }
  try {
    await promptPresence('Enable device unlock for HandCash')
    const buf = safeStorage.encryptString(secret)
    const wrote = durableSet(DEVICE_DEK_KEY, SEALED_PREFIX + buf.toString('base64'))
    if (!wrote) return { ok: false, error: 'Could not store device unlock material' }
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn('deviceAuthEnroll failed', err)
    return { ok: false, error: message }
  }
}

export async function deviceAuthUnlock(
  reason: unknown,
): Promise<{ ok: true; secret: string } | { ok: false; error: string }> {
  const why = typeof reason === 'string' && reason.trim() ? reason.trim() : 'Unlock HandCash'
  if (!canSeal()) return { ok: false, error: 'OS keychain sealing is not available' }
  const raw = durableGet(DEVICE_DEK_KEY)
  if (!raw || !raw.startsWith(SEALED_PREFIX)) {
    return { ok: false, error: 'Device unlock is not enabled' }
  }
  try {
    await promptPresence(why)
    const b64 = raw.slice(SEALED_PREFIX.length)
    const secret = safeStorage.decryptString(Buffer.from(b64, 'base64'))
    if (!secret) return { ok: false, error: 'Device unlock failed' }
    return { ok: true, secret }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn('deviceAuthUnlock failed', err)
    return { ok: false, error: message }
  }
}

export function deviceAuthClear(): { ok: true } {
  try {
    durableSet(DEVICE_DEK_KEY, '')
  } catch (err) {
    log.warn('deviceAuthClear failed', err)
  }
  return { ok: true }
}
