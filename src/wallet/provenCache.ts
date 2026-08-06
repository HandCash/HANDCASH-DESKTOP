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

const KEY = 'handcash.collectables.proven.v2'
const LEGACY_KEY = 'handcash.collectables.proven.v1'
const ORIGIN_KEY = 'handcash.collectables.originCommitments.v1'
const MAX_ENTRIES = 2_000

export type AuthenticityTier = 'brc156' | 'brc150' | 'unproven'

export type ProvenVerdict = {
  tier: AuthenticityTier
  /** Immutable origin commitment used by hardened BRC-156. */
  originScriptHash?: string
  verifiedAt: number
}

let verdicts: Map<string, ProvenVerdict> | null = null
let originCommitments: Map<string, string> | null = null

function load(): Map<string, ProvenVerdict> {
  if (verdicts) return verdicts
  verdicts = new Map()
  try {
    const raw = durableGetItem(KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      for (const [outpoint, value] of Object.entries(parsed)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue
        const candidate = value as Record<string, unknown>
        if (
          candidate.tier !== 'brc156' &&
          candidate.tier !== 'brc150' &&
          candidate.tier !== 'unproven'
        ) {
          continue
        }
        verdicts.set(key(outpoint), {
          tier: candidate.tier,
          originScriptHash:
            typeof candidate.originScriptHash === 'string'
              ? candidate.originScriptHash
              : undefined,
          verifiedAt:
            typeof candidate.verifiedAt === 'number' ? candidate.verifiedAt : 0,
        })
      }
    } else {
      // A v1 `true` came from the old shape-only verifier, so it cannot be
      // promoted into a cryptographic BRC-150 tier. Drop it and re-verify.
      // Negative verdicts remain safe cache entries.
      const legacy = durableGetItem(LEGACY_KEY)
      if (legacy) {
        const parsed = JSON.parse(legacy) as Record<string, unknown>
        for (const [outpoint, value] of Object.entries(parsed)) {
          if (value !== false) continue
          verdicts.set(key(outpoint), {
            tier: 'unproven',
            verifiedAt: 0,
          })
        }
      }
    }
  } catch {
    // A corrupt blob must not stop items listing.
  }
  return verdicts
}

function persist(map: Map<string, ProvenVerdict>): void {
  try {
    durableSetItem(KEY, JSON.stringify(Object.fromEntries(map)))
  } catch {
    // Optimisation only.
  }
}

function key(outpoint: string): string {
  return outpoint.trim().toLowerCase().replace(/_(\d+)$/, '.$1')
}

function originKey(origin: string): string {
  return origin.trim().toLowerCase().replace(/\.(\d+)$/, '_$1')
}

function loadOriginCommitments(): Map<string, string> {
  if (originCommitments) return originCommitments
  originCommitments = new Map()
  try {
    const raw = durableGetItem(ORIGIN_KEY)
    if (!raw) return originCommitments
    const parsed = JSON.parse(raw) as Record<string, unknown>
    for (const [origin, hash] of Object.entries(parsed)) {
      if (typeof hash === 'string' && /^[0-9a-f]{64}$/i.test(hash)) {
        originCommitments.set(originKey(origin), hash.toLowerCase())
      }
    }
  } catch {
    // A corrupt optimisation cache must not block verification.
  }
  return originCommitments
}

export function getOriginCommitment(origin: string): string | null {
  return loadOriginCommitments().get(originKey(origin)) ?? null
}

export function rememberOriginCommitment(origin: string, scriptHash: string): void {
  if (!/^[0-9a-f]{64}$/i.test(scriptHash)) {
    throw new Error('Invalid origin script commitment')
  }
  const map = loadOriginCommitments()
  const k = originKey(origin)
  const normalized = scriptHash.toLowerCase()
  const existing = map.get(k)
  if (existing && existing !== normalized) {
    throw new Error('Origin script commitment changed')
  }
  map.set(k, normalized)
  durableSetItem(ORIGIN_KEY, JSON.stringify(Object.fromEntries(map)))
}

/** Last recorded verdict. False when never verified — never a claim of forgery. */
export function isItemProven(outpoint: string): boolean {
  const tier = load().get(key(outpoint))?.tier
  return tier === 'brc156' || tier === 'brc150'
}

export function hasProvenVerdict(outpoint: string): boolean {
  return load().has(key(outpoint))
}

export function getProvenVerdict(outpoint: string): ProvenVerdict | null {
  return load().get(key(outpoint)) ?? null
}

export function rememberProvenVerdict(
  outpoint: string,
  verdict: boolean | AuthenticityTier | ProvenVerdict,
): void {
  const map = load()
  const k = key(outpoint)
  const normalized: ProvenVerdict =
    typeof verdict === 'boolean'
      ? { tier: verdict ? 'brc150' : 'unproven', verifiedAt: Date.now() }
      : typeof verdict === 'string'
        ? { tier: verdict, verifiedAt: Date.now() }
        : verdict
  map.delete(k)
  map.set(k, normalized)
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
  originCommitments = null
}
