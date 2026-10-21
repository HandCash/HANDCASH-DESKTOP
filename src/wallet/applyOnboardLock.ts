/**
 * Apply the onboarding "Protect this device" choice onto a just-created vault.
 * The vault is first sealed with a generated wrap password (never shown).
 */
import { changeVaultPassword, enableDeviceUnlock } from './vault'
import { validatePassword } from './passwordPolicy'
import {
  clearOpenUnlockSecret,
  setDeviceLockMode,
  setOpenUnlockSecret,
  type DeviceLockMode,
} from './deviceLockPrefs'

export async function applyOnboardLock(args: {
  wrapPassword: string
  mode: DeviceLockMode
  userPassword?: string
}): Promise<{ sessionPassword: string | null }> {
  const wrap = args.wrapPassword
  if (!wrap) throw new Error('Missing device wrap')

  if (args.mode === 'none') {
    setOpenUnlockSecret(wrap)
    setDeviceLockMode('none')
    return { sessionPassword: wrap }
  }

  if (args.mode === 'password' || args.mode === 'both') {
    const userPassword = args.userPassword ?? ''
    const pwError = validatePassword(userPassword)
    if (pwError) throw new Error(pwError)
    if (userPassword !== wrap) {
      await changeVaultPassword(wrap, userPassword)
    }
    clearOpenUnlockSecret()
    if (args.mode === 'both') {
      await enableDeviceUnlock(userPassword)
    }
    setDeviceLockMode(args.mode)
    return { sessionPassword: userPassword }
  }

  // Touch ID / device only — keep the wrap so existing unlock still works if
  // device auth is later cleared; do not store it as an auto-unlock secret.
  await enableDeviceUnlock(wrap)
  clearOpenUnlockSecret()
  setDeviceLockMode('device')
  return { sessionPassword: wrap }
}

/**
 * A device joined by approval skips "Protect this device": it takes the
 * panel's default, device unlock where available, else no prompt. Settings
 * changes it later.
 */
export async function applyJoinedDeviceLock(
  wrapPassword: string,
  deviceAvailable: boolean,
): Promise<{ sessionPassword: string | null; mode: DeviceLockMode }> {
  if (deviceAvailable) {
    try {
      return { ...(await applyOnboardLock({ wrapPassword, mode: 'device' })), mode: 'device' }
    } catch (err) {
      console.warn('[onboard] device unlock for a joined device failed', err)
    }
  }
  return { ...(await applyOnboardLock({ wrapPassword, mode: 'none' })), mode: 'none' }
}
