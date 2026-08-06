/**
 * Verified-authenticity flags per outpoint.
 *
 * A BRC-150 v2 remittance carries the BEEF that proves tip → origin, and that
 * blob runs to ~400k characters per item. Pulling it for a whole basket and
 * verifying every entry on each list is what made the app run out of memory once
 * a wallet held real ordinals, so listing never touches provenance now.
 *
 * Verification happens on demand for one outpoint at a time, and the answer is
 * recorded here. A given outpoint's remittance can never change — it is fixed by
 * the transaction that created it — so a stored verdict stays valid, including
 * across restarts.
 */
import { durableGetItem, durableSetItem } from './durableStorage'

const KEY = 'handcash.collectables.proven.v1'
const MAX_ENTRIES = 2_000

let verdicts: Map<string, boolean> | null = null

function load(): Map<string, boolean> {
  if (verdicts) return verdicts
  verdicts = new Map()
  try {
    const raw = durableGetItem(KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      for (const [outpoint, value] of Object.entries(parsed)) {
        if (typeof value === 'boolean') verdicts.set(outpoint, value)
      }
    }
  } catch {
    // A corrupt blob must not stop items listing.
  }
  return verdicts
}

function persist(map: Map<string, boolean>): void {
  try {
    durableSetItem(KEY, JSON.stringify(Object.fromEntries(map)))
  } catch {
    // Optimisation only.
  }
}

function key(outpoint: string): string {
  return outpoint.trim().toLowerCase().replace(/_(\d+)$/, '.$1')
}

/** Last recorded verdict. False when never verified — never a claim of forgery. */
export function isItemProven(outpoint: string): boolean {
  return load().get(key(outpoint)) === true
}

export function hasProvenVerdict(outpoint: string): boolean {
  return load().has(key(outpoint))
}

export function rememberProvenVerdict(outpoint: string, proven: boolean): void {
  const map = load()
  const k = key(outpoint)
  map.delete(k)
  map.set(k, proven)
  if (map.size > MAX_ENTRIES) {
    const drop = map.size - MAX_ENTRIES
    let i = 0
    for (const existing of map.keys()) {
      if (i++ >= drop) break
      map.delete(existing)
    }
  }
  persist(map)
}

export function resetProvenCacheForTests(): void {
  verdicts = null
}
