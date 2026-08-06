/**
 * Remembers which activity entries have already been shown to the user.
 *
 * The newest row flashes to announce an arrival. Deciding that from per-mount
 * state cannot tell a real arrival from simply opening the feed again, so every
 * visit to Activity announced whatever happened to be on top. Which entries the
 * user has laid eyes on is wallet state, not view state, so it lives here and
 * survives remounts and restarts.
 */
import { durableGetItem, durableSetItem } from './durableStorage'

const KEY = 'handcash.activitySeen.v1'
/** Newest ids kept; older ones can never flash again anyway. */
const MAX_SEEN = 500

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

export function hasSeenActivity(id: string): boolean {
  return load().has(id)
}

/** Record ids the feed has shown, newest first. */
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
