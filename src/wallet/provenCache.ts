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

export type AuthenticityTier = 'brc150' | 'unproven'

export type ProvenVerdict = {
  tier: AuthenticityTier
  /** Immutable origin script commitment (BRC-150 origin pin). */
  originScriptHash?: string
  /**
   * Origin established by verified BEEF, not by a sender's claim.
   *
   * Only a lineage proof writes this. It outranks remittance and indexer answers
   * wherever an origin is displayed or passed on, because it is the only one
   * backed by transactions the wallet checked itself.
   */
  origin?: string
  verifiedAt: number
}

export function isProvenTier(tier: AuthenticityTier): boolean {
  return tier === 'brc150'
}

/** Proven tiers never move backwards to unproven / weaker proofs. */
export function canAcceptVerdict(
  current: AuthenticityTier,
  next: AuthenticityTier,
): boolean {
  if (isProvenTier(current) && !isProvenTier(next)) return false
  return true
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
        // Legacy `brc156` verdicts were cryptographic origin pins — read them
        // forward as BRC-150 (the only proven tier now). Drop anything else.
        let tier: AuthenticityTier
        if (candidate.tier === 'brc156' || candidate.tier === 'brc150') {
          tier = 'brc150'
        } else if (candidate.tier === 'unproven') {
          tier = 'unproven'
        } else {
          continue
        }
        verdicts.set(key(outpoint), {
          tier,
          originScriptHash:
            typeof candidate.originScriptHash === 'string'
              ? candidate.originScriptHash
              : undefined,
          origin: typeof candidate.origin === 'string' ? candidate.origin : undefined,
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
  return load().get(key(outpoint))?.tier === 'brc150'
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
  const existing = map.get(k)
  // Monotonic authenticity: never let a transient ladder miss erase BRC-150.
  if (existing && !canAcceptVerdict(existing.tier, normalized.tier)) {
    return
  }
  // Prefer keeping a proven origin when a later write omits it.
  const merged: ProvenVerdict = {
    ...normalized,
    origin: normalized.origin ?? existing?.origin,
    originScriptHash: normalized.originScriptHash ?? existing?.originScriptHash,
    verifiedAt: normalized.verifiedAt || Date.now(),
  }
  map.delete(k)
  map.set(k, merged)
  if (map.size > MAX_ENTRIES) {
    const drop = map.size - MAX_ENTRIES
    let i = 0
    for (const existingKey of map.keys()) {
      if (i++ >= drop) break
      map.delete(existingKey)
    }
  }
  persist(map)
}

/**
 * Paint authenticity from the durable verdict store — list cache alone can
 * still say `unproven` after a prior session proved the tip.
 */
export function authenticityFromProvenCache(outpoint: string): {
  authenticity: AuthenticityTier
  proven: boolean
} {
  const verdict = getProvenVerdict(outpoint)
  if (!verdict) return { authenticity: 'unproven', proven: false }
  return {
    authenticity: verdict.tier,
    proven: isProvenTier(verdict.tier),
  }
}

/** True when a cryptographically proven tier is already on disk. */
export function hasProvenTier(outpoint: string): boolean {
  return getProvenVerdict(outpoint)?.tier === 'brc150'
}

const GENESIS_KEY = 'handcash.collectables.genesisAttempt.v1'
/**
 * How long a failed lineage walk is left alone.
 *
 * A walk costs a fetch per hop, so retrying on every list would be far worse
 * than the missing badge it is trying to earn. A day is short enough that a hop
 * which was simply unmined at the time gets another chance.
 */
export const GENESIS_RETRY_MS = 24 * 60 * 60_000
const GENESIS_MAX_ENTRIES = 500

let genesisAttempts: Map<string, number> | null = null

function loadGenesisAttempts(): Map<string, number> {
  if (genesisAttempts) return genesisAttempts
  genesisAttempts = new Map()
  try {
    const raw = durableGetItem(GENESIS_KEY)
    if (!raw) return genesisAttempts
    const parsed = JSON.parse(raw) as Record<string, unknown>
    for (const [outpoint, at] of Object.entries(parsed)) {
      if (typeof at === 'number') genesisAttempts.set(key(outpoint), at)
    }
  } catch {
    // Losing the record costs one extra walk, not correctness.
  }
  return genesisAttempts
}

/** True when a tip with no proof may be walked back to its inscription now. */
export function shouldAttemptGenesis(
  outpoint: string,
  now = Date.now(),
  retryMs = GENESIS_RETRY_MS,
): boolean {
  const k = key(outpoint)
  if (load().get(k)?.tier === 'brc150') return false
  const attempted = loadGenesisAttempts().get(k)
  return attempted == null || now - attempted >= retryMs
}

export function rememberGenesisAttempt(outpoint: string, now = Date.now()): void {
  const map = loadGenesisAttempts()
  const k = key(outpoint)
  map.delete(k)
  map.set(k, now)
  if (map.size > GENESIS_MAX_ENTRIES) {
    let drop = map.size - GENESIS_MAX_ENTRIES
    for (const existing of map.keys()) {
      if (drop-- <= 0) break
      map.delete(existing)
    }
  }
  try {
    durableSetItem(GENESIS_KEY, JSON.stringify(Object.fromEntries(map)))
  } catch {
    // Optimisation only.
  }
}

const GENESIS_FAILURE_KEY = 'handcash.collectables.genesisFailure.v1'
const GENESIS_FAILURE_MAX_ENTRIES = 200

/**
 * Why the last lineage walk for a tip did not produce a proof.
 *
 * `invalid` is a verdict about the item — the chain says it cannot be proven.
 * Everything else is a verdict about the attempt, and is worth retrying. Keeping
 * them apart is the difference between telling someone their item is stuck and
 * telling them it is unprovable.
 */
export type GenesisFailureKind = 'aborted' | 'unavailable' | 'overBudget' | 'invalid'

export type GenesisFailure = { kind: GenesisFailureKind; reason: string; at: number }

let genesisFailures: Map<string, GenesisFailure> | null = null

function loadGenesisFailures(): Map<string, GenesisFailure> {
  if (genesisFailures) return genesisFailures
  genesisFailures = new Map()
  try {
    const raw = durableGetItem(GENESIS_FAILURE_KEY)
    if (!raw) return genesisFailures
    const parsed = JSON.parse(raw) as Record<string, unknown>
    for (const [outpoint, value] of Object.entries(parsed)) {
      const entry = value as Partial<GenesisFailure>
      if (typeof entry?.kind !== 'string' || typeof entry?.reason !== 'string') continue
      genesisFailures.set(key(outpoint), {
        kind: entry.kind as GenesisFailureKind,
        reason: entry.reason,
        at: typeof entry.at === 'number' ? entry.at : 0,
      })
    }
  } catch {
    // Diagnostics only — losing them costs an explanation, not correctness.
  }
  return genesisFailures
}

function persistGenesisFailures(map: Map<string, GenesisFailure>): void {
  try {
    durableSetItem(GENESIS_FAILURE_KEY, JSON.stringify(Object.fromEntries(map)))
  } catch {
    // Diagnostics only.
  }
}

export function rememberGenesisFailure(
  outpoint: string,
  kind: GenesisFailureKind,
  reason: string,
  now = Date.now(),
): void {
  const map = loadGenesisFailures()
  const k = key(outpoint)
  map.delete(k)
  map.set(k, { kind, reason, at: now })
  if (map.size > GENESIS_FAILURE_MAX_ENTRIES) {
    let drop = map.size - GENESIS_FAILURE_MAX_ENTRIES
    for (const existing of map.keys()) {
      if (drop-- <= 0) break
      map.delete(existing)
    }
  }
  persistGenesisFailures(map)
}

export function getGenesisFailure(outpoint: string): GenesisFailure | null {
  return loadGenesisFailures().get(key(outpoint)) ?? null
}

export function clearGenesisFailure(outpoint: string): void {
  const map = loadGenesisFailures()
  if (!map.delete(key(outpoint))) return
  persistGenesisFailures(map)
}

export function resetProvenCacheForTests(): void {
  verdicts = null
  originCommitments = null
  genesisAttempts = null
  genesisFailures = null
}
