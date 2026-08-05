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

/** Long enough that a refresh loop stops re-walking, short enough to pick up new indexing. */
export const RESOLVE_RETRY_MS = 10 * 60_000

type Stored = Record<string, ResolvedInscription>

let hits: Map<string, ResolvedInscription> | null = null
const missAt = new Map<string, number>()

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
    }
  } catch {
    // A corrupt blob must not keep the page from listing.
  }
  return hits
}

function persist(map: Map<string, ResolvedInscription>): void {
  try {
    durableSetItem(KEY, JSON.stringify(Object.fromEntries(map)))
  } catch {
    // Cache is an optimisation; losing it costs speed, not correctness.
  }
}

export function getResolvedInscription(outpoint: string): ResolvedInscription | null {
  return load().get(outpoint) ?? null
}

export function rememberResolvedInscription(
  outpoint: string,
  resolved: ResolvedInscription,
): void {
  const map = load()
  map.set(outpoint, resolved)
  missAt.delete(outpoint)
  persist(map)
}

/** Note that the indexer had nothing for this outpoint, so we back off. */
export function rememberUnresolved(outpoint: string, now = Date.now()): void {
  missAt.set(outpoint, now)
}

/** False while a recent miss is still fresh. */
export function shouldResolveInscription(outpoint: string, now = Date.now()): boolean {
  if (load().has(outpoint)) return false
  const missed = missAt.get(outpoint)
  return missed == null || now - missed >= RESOLVE_RETRY_MS
}

export function resetInscriptionCacheForTests(): void {
  hits = null
  missAt.clear()
}
