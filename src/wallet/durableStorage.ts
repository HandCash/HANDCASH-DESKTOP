/** Origin-independent prefs via Electron userData (falls back to localStorage). */

export type DurableSetOptions = {
  /** Recovery-only: replace vault when identityKey changes (archives previous). */
  allowVaultIdentityReplace?: boolean
}

/**
 * Values already read this session.
 *
 * `storageGetSync` is `ipcRenderer.sendSync`, which parks the renderer until the
 * main process answers, and the localStorage mirror below is a synchronous write
 * on top of that. Callers treat these reads as free — guards re-read per outpoint
 * inside list loops, and the activity feed re-reads on every render — so without
 * a cache a single click pays for dozens of round trips and the UI visibly stalls.
 *
 * Every write in this renderer refreshes the entry, so the cache cannot drift from
 * what we stored. `null` means "known absent"; a cache miss is `undefined`.
 */
const cache = new Map<string, string | null>()

function readThrough(key: string): string | null {
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

export function durableGetItem(key: string): string | null {
  const cached = cache.get(key)
  if (cached !== undefined) {
    // Electron delete writes '' — treat empty as absent so callers do not
    // confuse a wiped key with a stored empty payload.
    return cached === '' ? null : cached
  }
  const value = readThrough(key)
  const normalized = value === '' ? null : value
  cache.set(key, normalized)
  return normalized
}

export function durableSetItem(key: string, value: string, opts?: DurableSetOptions): boolean {
  try {
    localStorage.setItem(key, value)
  } catch {
    // ignore quota / private mode
  }
  try {
    const ok = window.handcash?.storageSetSync?.(key, value, opts)
    if (typeof ok === 'boolean') {
      // A rejected write must not be cached as though it stuck.
      if (ok) cache.set(key, value)
      else cache.delete(key)
      return ok
    }
  } catch {
    // ignore
  }
  // Browser / no Electron bridge — localStorage write is best-effort success.
  cache.set(key, value)
  return true
}

/**
 * Clear a key from both stores.
 *
 * Removing it from localStorage alone leaves the Electron copy behind, and the
 * next read migrates that stale value straight back.
 */
export function durableRemoveItem(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // ignore
  }
  try {
    // The bridge has no delete — empty reads as absent everywhere we use it.
    window.handcash?.storageSetSync?.(key, '')
  } catch {
    // ignore
  }
  cache.set(key, null)
}

/** Drop cached reads when something outside this renderer may have written. */
export function durableForgetCached(key?: string): void {
  if (key == null) cache.clear()
  else cache.delete(key)
}
