/**
 * Where "Protect this device" starts, and whether it may offer no lock.
 *
 * A wallet with no lock keeps its unlock secret beside the vault, sealed only
 * by the OS keystore (Keychain, DPAPI, the Linux secret service). With no
 * keystore, as on Linux without a keyring, that secret would sit in plain
 * text and anyone who can read the files could open the wallet.
 */
import type { DeviceLockMode } from './deviceLockPrefs'

export type ProtectChoice = {
  defaultMode: DeviceLockMode
  noneAllowed: boolean
}

export function protectChoice(args: { deviceAvailable: boolean; osKeyStorage: boolean }): ProtectChoice {
  return {
    defaultMode: args.deviceAvailable ? 'device' : 'password',
    noneAllowed: args.osKeyStorage,
  }
}

/** Whether this install seals wallet secrets with an OS keystore; a bridge that cannot say counts as no. */
export async function osKeyStorageAvailable(): Promise<boolean> {
  const api = window.handcash?.safeStorageAvailable
  if (!api) return false
  try {
    return await api()
  } catch {
    return false
  }
}
