/**
 * Remembers resolved inscription metadata per outpoint.
 *
 * `resolveOneSatInscription` walks the chain backwards through GorillaPool and
 * WhatsOnChain — up to ~7 hops, each hop costing a txo lookup plus a transaction
 * fetch plus a lookup per input. Listing N items used to pay that per item, on
 * every open of the Collect page and again every 30s, which is what locked the
 * phone up.
 *
 * What an outpoint is inscribed with cannot change, so a hit is valid forever and
 * survives restarts. A miss only means "not indexed yet", so it is retried, but
 * not on every refresh.
 */
import { durableGetItem, durableSetItem } from './durableStorage'
import type { ResolvedInscription } from './oneSatImport'

const KEY = 'handcash.inscriptionResolution.v1'
/**
 * Misses are durable too. Keeping them in memory only meant every restart paid
 * a full backwards walk for every stray dust output the indexer has never heard
 * of, serially, before the wallet could finish a sync.
 */
const MISS_KEY = 'handcash.inscriptionMiss.v1'

/** Long enough that a refresh loop stops re-walking, short enough to pick up new indexing. */
export const RESOLVE_RETRY_MS = 10 * 60_000
/**
 * Retry window for a tip a latch already proved is an item.
 *
 * These must not wait out the stray-dust backoff — the user is watching a
 * transfer that has landed. They must not re-walk on every poll either: one
 * walk costs a txo lookup plus a transaction fetch plus a lookup per input,
 * per hop, so an 8s poll turns a single pending tip into a request flood that
 * gets the wallet throttled by the very indexers it is waiting on.
 */
export const PENDING_RETRY_MS = 45_000
/** Hard cap so a flood of dust cannot grow the durable blob without bound. */
export const RESOLVE_HIT_MAX = 2_000
const MISS_MAX = 500

type Stored = Record<string, ResolvedInscription>

let hits: Map<string, ResolvedInscription> | null = null
let misses: Map<string, number> | null = null

function loadMisses(): Map<string, number> {
  if (misses) return misses
  misses = new Map()
  try {
    const raw = durableGetItem(MISS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, number>
      const now = Date.now()
      for (const [outpoint, at] of Object.entries(parsed)) {
        if (typeof at === 'number' && now - at < RESOLVE_RETRY_MS) misses.set(outpoint, at)
      }
    }
  } catch {
    // A corrupt blob only costs us the backoff, so start clean.
  }
  return misses
}

function persistMisses(map: Map<string, number>): void {
  try {
    durableSetItem(MISS_KEY, JSON.stringify(Object.fromEntries(map)))
  } catch {
    // Cache is an optimisation; losing it costs speed, not correctness.
  }
}

function load(): Map<string, ResolvedInscription> {
  if (hits) return hits
  hits = new Map()
  try {
    const raw = durableGetItem(KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Stored
      for (const [outpoint, resolved] of Object.entries(parsed)) {
        if (resolved && typeof resolved.origin === 'string') {
          hits.set(outpoint, {
            ...resolved,
            traits: resolved.traits ?? [],
            extras: resolved.extras ?? [],
          })
        }
      }
      // Older installs may already exceed the cap.
      trimHits(hits)
    }
  } catch {
    // A corrupt blob must not keep the page from listing.
  }
  return hits
}

function trimHits(map: Map<string, ResolvedInscription>): void {
  if (map.size <= RESOLVE_HIT_MAX) return
  const drop = map.size - RESOLVE_HIT_MAX
  let i = 0
  for (const key of map.keys()) {
    if (i++ >= drop) break
    map.delete(key)
  }
}

function trimMisses(now = Date.now()): void {
  const map = loadMisses()
  for (const [key, at] of map) {
    if (now - at >= RESOLVE_RETRY_MS) map.delete(key)
  }
  if (map.size <= MISS_MAX) return
  const drop = map.size - MISS_MAX
  let i = 0
  for (const key of map.keys()) {
    if (i++ >= drop) break
    map.delete(key)
  }
}

function persist(map: Map<string, ResolvedInscription>): void {
  try {
    durableSetItem(KEY, JSON.stringify(Object.fromEntries(map)))
  } catch {
    // Cache is an optimisation; losing it costs speed, not correctness.
  }
}

export function getResolvedInscription(outpoint: string): ResolvedInscription | null {
  const hit = load().get(outpoint) ?? null
  if (!hit) return null
  // A self-origin with no content is an indexer placeholder we must not treat
  // as a final identity — it blocks re-walks and paints a broken image forever.
  if (isPlaceholderResolution(outpoint, hit)) return null
  return hit
}

/**
 * True when a cached hit is only "this tip is its own origin" with no inscription
 * metadata — the answer GorillaPool gives for unindexed 1-sat outputs.
 */
export function isPlaceholderResolution(
  outpoint: string,
  resolved: ResolvedInscription,
): boolean {
  const key = (v: string) => v.trim().toLowerCase().replace(/\.(\d+)$/, '_$1')
  if (key(resolved.origin) !== key(outpoint)) return false
  return !resolved.mimeType && (resolved.traits?.length ?? 0) === 0
}

export function rememberResolvedInscription(
  outpoint: string,
  resolved: ResolvedInscription,
): void {
  if (isPlaceholderResolution(outpoint, resolved)) return
  const map = load()
  // Re-insert so a refreshed hit is treated as newest when we trim from the front.
  map.delete(outpoint)
  map.set(outpoint, resolved)
  const missMap = loadMisses()
  if (missMap.delete(outpoint)) persistMisses(missMap)
  trimHits(map)
  persist(map)
}

/** Note that the indexer had nothing for this outpoint, so we back off. */
export function rememberUnresolved(outpoint: string, now = Date.now()): void {
  const map = loadMisses()
  map.set(outpoint, now)
  trimMisses(now)
  persistMisses(map)
}

/**
 * False while a recent miss is still fresh.
 *
 * `retryMs` lets a latch-proven tip come back sooner than stray dust without
 * dropping the backoff altogether.
 */
export function shouldResolveInscription(
  outpoint: string,
  now = Date.now(),
  retryMs = RESOLVE_RETRY_MS,
): boolean {
  const hit = load().get(outpoint)
  if (hit && !isPlaceholderResolution(outpoint, hit)) return false
  const map = loadMisses()
  const missed = map.get(outpoint)
  if (missed != null && now - missed < retryMs) return false
  if (missed != null) {
    map.delete(outpoint)
    persistMisses(map)
  }
  return true
}

export function resetInscriptionCacheForTests(): void {
  hits = null
  misses = null
}
