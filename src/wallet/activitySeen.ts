/**
 * Remembers which activity entries have already been shown to the user.
 *
 * The newest row flashes to announce an arrival. Deciding that from per-mount
 * state cannot tell a real arrival from simply opening the feed again, so every
 * visit to Activity announced whatever happened to be on top. Which entries the
 * user has laid eyes on is wallet state, not view state, so it lives here and
 * survives remounts and restarts.
 *
 * Entries are recorded under `activityEntryKey`, not the row's `id`: an id is
 * minted from the clock per write, so a restored or re-recorded row looked
 * brand new and flashed again.
 */
import { durableGetItem, durableSetItem } from './durableStorage'

/** v2 keys rows by event identity; v1 ids can never match again. */
const KEY = 'handcash.activitySeen.v2'
/** Newest keys kept; older ones can never flash again anyway. */
const MAX_SEEN = 500
/**
 * How recent an entry must be to be worth announcing.
 *
 * The flash means "this just landed". Nothing older is an arrival no matter what
 * the seen record says, so a gap in that record — a re-recorded row, a wiped
 * store, a device that restored its history — can no longer make an old
 * transaction flash every time the tab is opened.
 */
export const FLASH_MAX_AGE_MS = 10 * 60_000

let seen: Map<string, true> | null = null
let ready = false

function load(): Map<string, true> {
  if (seen) return seen
  seen = new Map()
  try {
    const raw = durableGetItem(KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) {
        for (const id of parsed) {
          if (typeof id === 'string' && id) seen.set(id, true)
        }
        ready = true
      }
    }
  } catch {
    // A corrupt blob costs one silent pass, not a wrong flash.
  }
  return seen
}

function persist(map: Map<string, true>): void {
  try {
    durableSetItem(KEY, JSON.stringify([...map.keys()]))
    ready = true
  } catch {
    // Best effort; the in-memory set still suppresses repeat flashes.
  }
}

/**
 * False until the wallet has recorded a feed once.
 *
 * A fresh install or a restored history is entirely unseen, and announcing that
 * is indistinguishable from the bug this exists to prevent. The first pass seeds
 * quietly instead.
 */
export function activitySeenReady(): boolean {
  load()
  return ready
}

export function hasSeenActivity(key: string): boolean {
  return load().has(key)
}

/**
 * True when the feed should announce this entry as an arrival.
 *
 * Both conditions must hold: the wallet has recorded a feed before (so a first
 * load or a restored history stays quiet), and the entry is both unseen and
 * recent enough to still be an arrival.
 */
export function shouldAnnounceActivity(
  key: string,
  at: number,
  now = Date.now(),
): boolean {
  if (!activitySeenReady()) return false
  if (!Number.isFinite(at) || now - at > FLASH_MAX_AGE_MS) return false
  return !hasSeenActivity(key)
}

/** Record keys the feed has shown, newest first. */
export function markActivitySeen(ids: readonly string[]): void {
  const map = load()
  let added = false
  // Oldest first, so trimming from the front drops the oldest ids.
  for (let i = ids.length - 1; i >= 0; i--) {
    const id = ids[i]
    if (!id || map.has(id)) continue
    map.set(id, true)
    added = true
  }
  if (!added && ready) return
  if (map.size > MAX_SEEN) {
    let drop = map.size - MAX_SEEN
    for (const id of map.keys()) {
      if (drop-- <= 0) break
      map.delete(id)
    }
  }
  persist(map)
}

export function resetActivitySeenForTests(): void {
  seen = null
  ready = false
}
