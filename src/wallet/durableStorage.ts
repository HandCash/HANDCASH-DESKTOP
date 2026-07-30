/** Origin-independent prefs via Electron userData (falls back to localStorage). */

export type DurableSetOptions = {
  /** Recovery-only: replace vault when identityKey changes (archives previous). */
  allowVaultIdentityReplace?: boolean
}

export function durableGetItem(key: string): string | null {
  try {
    const fromElectron = window.handcash?.storageGetSync?.(key)
    if (typeof fromElectron === 'string') {
      try {
        localStorage.setItem(key, fromElectron)
      } catch {
        // ignore mirror failures
      }
      return fromElectron
    }
  } catch {
    // fall through
  }

  try {
    const local = localStorage.getItem(key)
    if (local != null) {
      // Migrate browser/dev localStorage into Electron durable store when available.
      try {
        window.handcash?.storageSetSync?.(key, local)
      } catch {
        // ignore
      }
    }
    return local
  } catch {
    return null
  }
}

export function durableSetItem(key: string, value: string, opts?: DurableSetOptions): boolean {
  try {
    localStorage.setItem(key, value)
  } catch {
    // ignore quota / private mode
  }
  try {
    const ok = window.handcash?.storageSetSync?.(key, value, opts)
    if (typeof ok === 'boolean') return ok
  } catch {
    // ignore
  }
  // Browser / no Electron bridge — localStorage write is best-effort success.
  return true
}
