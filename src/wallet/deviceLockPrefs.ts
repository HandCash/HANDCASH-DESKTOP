/**
 * How this device unlocks HandCash after onboarding.
 *
 * Stored in durable prefs (OS-sealed when the key is under the vault prefix).
 * Legacy wallets with no pref keep using vault password / device factors as-is.
 */
import { durableGetItem, durableRemoveItem, durableSetItem } from './durableStorage'
import { readVaultUnlockFactors } from './vault'

export type DeviceLockMode = 'none' | 'password' | 'device' | 'both'

const MODE_KEY = 'handcash.brc100.deviceLock.mode'
const OPEN_SECRET_KEY = 'handcash.brc100.vault.openSecret.v1'

type Listener = () => void
const listeners = new Set<Listener>()

function notify() {
  for (const listener of listeners) listener()
}

export function subscribeDeviceLock(listener: Listener): () => void {
  listeners.add(listener)
  listener()
  return () => {
    listeners.delete(listener)
  }
}

/** Explicit onboarding/settings choice, or null for pre-onboarding wallets. */
export function getDeviceLockMode(): DeviceLockMode | null {
  const raw = durableGetItem(MODE_KEY)
  if (raw === 'none' || raw === 'password' || raw === 'device' || raw === 'both') return raw
  return null
}

export function setDeviceLockMode(mode: DeviceLockMode): void {
  durableSetItem(MODE_KEY, mode)
  notify()
}

export function clearDeviceLockMode(): void {
  durableRemoveItem(MODE_KEY)
  notify()
}

/**
 * Wrapping password used when the holder chose no prompt (or as a crash-safe
 * hold during onboarding before Protect this device).
 */
export function setOpenUnlockSecret(secret: string): void {
  durableSetItem(OPEN_SECRET_KEY, secret)
}

export function getOpenUnlockSecret(): string | null {
  return durableGetItem(OPEN_SECRET_KEY)
}

export function clearOpenUnlockSecret(): void {
  durableRemoveItem(OPEN_SECRET_KEY)
}

/** Meets vault password policy; never shown to the holder. */
export function generateWrapSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  const body = btoa(bin).replace(/[+/=]/g, 'x')
  return `Hc1${body}`
}

export function isNoDeviceLock(): boolean {
  return getDeviceLockMode() === 'none' && Boolean(getOpenUnlockSecret())
}

/** Lock screen / idle timer should open the wallet without a prompt. */
export function shouldAutoUnlock(): boolean {
  return isNoDeviceLock()
}

export function inferDeviceLockMode(): DeviceLockMode {
  const stored = getDeviceLockMode()
  if (stored) return stored
  const factors = readVaultUnlockFactors()
  if (factors.password && factors.device) return 'both'
  if (factors.device) return 'device'
  if (factors.password) return 'password'
  return 'none'
}
