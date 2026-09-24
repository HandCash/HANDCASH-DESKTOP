/** Origin-independent prefs via Electron userData (falls back to localStorage). */
import { storageRegistry } from '../storage/registry'

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
/** Legacy wallet keys already checked in this renderer. */
const cleanedLegacyKeys = new Set<string>()

/**
 * Largest value worth mirroring into `localStorage` when Electron already holds
 * the durable copy.
 *
 * `localStorage.setItem` is synchronous on the renderer thread, and this store
 * carries multi-megabyte values (chat, activity, item art). Mirroring those
 * charged the renderer a megabyte-scale write per read-through and per write,
 * on top of the synchronous IPC — and they exceed the origin quota anyway, so
 * the write threw and was swallowed. The mirror exists for the dev browser and
 * for migrating an old localStorage wallet, both of which only need small keys.
 */
const LOCAL_MIRROR_MAX_BYTES = 64 * 1024
const WALLET_KEY_RE = /^(.*):wallet:(main|test):(\d+):([^:]+)$/
const PROBE_KEY = storageRegistry.durableStoreProbe.key

/**
 * Which process holds the durable copy.
 *
 * `shell` — the host app owns a file store; origin storage is only a mirror for
 * small keys, because writing multi-megabyte values there costs the renderer a
 * synchronous write it does not need.
 * `origin` — the WebView's own storage *is* the store (mobile shell, dev
 * browser), so every value must be written there in full.
 *
 * A shell that answers `storageSetSync` with `true` while storing nothing is
 * indistinguishable from Electron by return value alone: writes report success,
 * anything over the mirror cap reaches no store at all, and Activity, chat and
 * inventory silently reset on relaunch. Verify the claim once by reading a
 * write back instead of trusting it.
 */
type DurableStoreOwner = 'shell' | 'origin'

let storeOwner: DurableStoreOwner | null = null

function durableStoreOwner(): DurableStoreOwner {
  if (storeOwner) return storeOwner
  const bridge = typeof window === 'undefined' ? undefined : window.handcash
  if (!bridge?.storageSetSync || !bridge.storageGetSync) return (storeOwner = 'origin')
  try {
    const token = `probe:${Date.now()}:${Math.random().toString(36).slice(2)}`
    const accepted = bridge.storageSetSync(PROBE_KEY, token)
    storeOwner =
      accepted === true && bridge.storageGetSync(PROBE_KEY) === token
        ? 'shell'
        : 'origin'
  } catch {
    storeOwner = 'origin'
  }
  if (storeOwner === 'origin') {
    console.info('[durable] shell store does not read back — origin storage owns wallet state')
  }
  return storeOwner
}

/** Re-probe after a test swaps the bridge. */
export function __resetDurableStoreOwnerForTests(): void {
  storeOwner = null
}

function mirrorLocally(key: string, value: string): void {
  if (value.length > LOCAL_MIRROR_MAX_BYTES) return
  try {
    localStorage.setItem(key, value)
  } catch {
    // ignore quota / private mode
  }
}

function readThrough(key: string): string | null {
  if (durableStoreOwner() === 'shell') {
    try {
      const fromShell = window.handcash?.storageGetSync?.(key)
      if (typeof fromShell === 'string') {
        mirrorLocally(key, fromShell)
        return fromShell
      }
    } catch {
      // fall through
    }

    try {
      const local = localStorage.getItem(key)
      if (local != null) {
        // Migrate a pre-Electron browser wallet up into the shell store.
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

  try {
    return localStorage.getItem(key)
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
  let value = readThrough(key)
  if (value === '') value = null
  // Account-local storage used two historical shapes: an unscoped primary
  // key and `base:identityKey` for children. A runtime always reads its fully
  // namespaced key. On the first read only, import the one legacy source that
  // can belong to this runtime; never fan a device-global blob into multiple
  // wallets.
  if (value == null) {
    const scoped = WALLET_KEY_RE.exec(key)
    if (scoped) {
      const [, base, , rawIndex, identityKey] = scoped
      const legacyKey = Number(rawIndex) === 0 ? base! : `${base}:${identityKey}`
      const cachedLegacy = cache.get(legacyKey)
      const legacy =
        cachedLegacy !== undefined ? cachedLegacy : readThrough(legacyKey)
      if (legacy != null && legacy !== '') {
        if (durableSetItem(key, legacy)) {
          value = legacy
          removeMigratedLegacyKey(legacyKey, legacy.length)
        }
      }
    }
  }
  // Earlier migrations copied into the account namespace but retained the old
  // value forever. On mobile that doubled the largest stores (BRC-150 and
  // messages alone consumed another megabyte) until the 5MB WebView quota
  // rejected custody queues and logs. A present scoped value is authoritative,
  // so the old account-0 / identity-suffixed copy is safe to remove.
  if (value != null) {
    const scoped = WALLET_KEY_RE.exec(key)
    if (scoped) {
      const [, base, , rawIndex, identityKey] = scoped
      const legacyKey = Number(rawIndex) === 0 ? base! : `${base}:${identityKey}`
      if (!cleanedLegacyKeys.has(legacyKey)) {
        let legacy: string | null = null
        try {
          legacy = readThrough(legacyKey)
        } catch {
          // ignore an unreadable old copy
        }
        if (legacy != null && legacy !== '') {
          removeMigratedLegacyKey(legacyKey, legacy.length)
        } else {
          cleanedLegacyKeys.add(legacyKey)
        }
      }
    }
  }
  const normalized = value === '' ? null : value
  cache.set(key, normalized)
  return normalized
}

function removeMigratedLegacyKey(key: string, bytes: number): void {
  if (cleanedLegacyKeys.has(key)) return
  cleanedLegacyKeys.add(key)
  durableRemoveItem(key)
  console.info(
    `[storage] removed migrated legacy copy ${key} (${Math.round(
      bytes / 1024,
    )}KB)`,
  )
}

export function durableSetItem(key: string, value: string, opts?: DurableSetOptions): boolean {
  if (durableStoreOwner() === 'shell') {
    try {
      const ok = window.handcash?.storageSetSync?.(key, value, opts)
      if (typeof ok === 'boolean') {
        // The shell owns the durable copy — localStorage is only a small-key mirror.
        mirrorLocally(key, value)
        // A rejected write must not be cached as though it stuck.
        if (ok) cache.set(key, value)
        else cache.delete(key)
        return ok
      }
    } catch {
      // ignore
    }
  }
  // No shell store (mobile shell, dev browser): localStorage is the store, not
  // a mirror, so the whole value goes in regardless of size.
  // Hermetic/node tests have neither bridge nor localStorage; preserve the
  // process-local cache there so independent wallet modules remain testable.
  if (typeof localStorage === 'undefined') {
    cache.set(key, value)
    return true
  }
  try {
    localStorage.setItem(key, value)
    cache.set(key, value)
    return true
  } catch {
    // A quota/private-mode failure is a failed durable write. Do not cache the
    // value and report success: custody queues use this result to distinguish a
    // retryable signed cheque from one that would disappear on process exit.
    cache.delete(key)
    reportStoragePressure(key, value.length)
    return false
  }
}

/** Last time the store was reported full, so a burst of refusals says it once. */
let lastPressureReportAt = 0
const PRESSURE_REPORT_INTERVAL_MS = 60_000

/**
 * Name what filled the store when a durable write is refused.
 *
 * Callers below this layer only see `false`, so a full store surfaced as
 * unrelated symptoms — cheques that would not archive, Activity rows that
 * vanished on reload — with nothing saying the device had simply run out of
 * room, or which key to blame.
 */
function reportStoragePressure(key: string, wanted: number): void {
  const now = Date.now()
  if (now - lastPressureReportAt < PRESSURE_REPORT_INTERVAL_MS) return
  lastPressureReportAt = now
  try {
    let total = 0
    const sizes: Array<{ key: string; bytes: number }> = []
    for (let i = 0; i < localStorage.length; i++) {
      const name = localStorage.key(i)
      if (name == null) continue
      const bytes = (localStorage.getItem(name)?.length ?? 0) + name.length
      total += bytes
      sizes.push({ key: name, bytes })
    }
    sizes.sort((a, b) => b.bytes - a.bytes)
    const worst = sizes
      .slice(0, 5)
      .map((row) => `${row.key}=${Math.round(row.bytes / 1024)}KB`)
      .join(' ')
    console.error(
      `[storage] durable write refused for ${key} (${Math.round(
        wanted / 1024,
      )}KB) — ${Math.round(total / 1024)}KB held across ${
        sizes.length
      } keys · largest: ${worst}`,
    )
  } catch {
    console.error(`[storage] durable write refused for ${key}`)
  }
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
  if (durableStoreOwner() === 'shell') {
    try {
      // The bridge has no delete — empty reads as absent everywhere we use it.
      window.handcash?.storageSetSync?.(key, '')
    } catch {
      // ignore
    }
  }
  cache.set(key, null)
}

/** Drop cached reads when something outside this renderer may have written. */
export function durableForgetCached(key?: string): void {
  if (key == null) {
    cache.clear()
    cleanedLegacyKeys.clear()
  }
  else cache.delete(key)
}
