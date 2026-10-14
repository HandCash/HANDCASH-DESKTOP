import { storageRegistry } from '../storage/registry'
import { durableGetItem, durableRemoveItem, durableSetItem } from './durableStorage'
import {
  packageImageBytes,
  parseProfileCertificate,
  type IdentityProfile,
  type IdentityProfileRecord,
  type PackageImage,
} from './identityProfile'
import { IDENTITY_DESCRIPTION_MAX, IDENTITY_NAME_MAX } from './issuerIdentity'
import { normalizeIssuerIdentityKey } from './issuerMetadata'
import type { Chain } from './vault'

/**
 * Self-published profiles, one per identity key (BRC-248 §8). Each is kept
 * only after its certificate verified, so reads need no signature check. Only
 * the identity key can sign its profile, so the latest `issuedAt` always wins
 * and an older copy can never be replayed over a newer one.
 *
 * Profiles of keys this wallet controls are pinned; a profile that a contact
 * or a held asset names is held. Neither is evicted; at most `MAX_UNHELD`
 * profiles nothing on this device names are kept.
 */

type StoredProfile = { record: IdentityProfileRecord; name: string; description: string; issuedAt: string }
type IndexEntry = { identityKey: string; storedAt: number; pinned?: true }
/** `holds` maps a persisted list's durable key to the identity keys it names. */
type Index = { version: 1; entries: IndexEntry[]; holds?: Record<string, string[]> }

const MAX_UNHELD = 8
const BASE = storageRegistry.identityProfiles.key
const indexKey = (chain: Chain) => `${BASE}:${chain}`
const entryKey = (chain: Chain, identityKey: string) => `${BASE}:${chain}:${identityKey}`

const decoded = new Map<string, IdentityProfile | null>()
const listeners = new Set<() => void>()
let generation = 0

export function subscribeIdentityProfiles(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function identityProfilesGeneration(): number {
  return generation
}

function announce() {
  generation++
  for (const listener of listeners) listener()
}

function keyList(raw: Iterable<unknown>): string[] {
  const keys = new Set<string>()
  for (const value of raw) {
    const key = normalizeIssuerIdentityKey(value)
    if (key) keys.add(key)
  }
  return [...keys].sort()
}

function readIndex(chain: Chain): Index {
  try {
    const raw = durableGetItem(indexKey(chain))
    const parsed = raw ? (JSON.parse(raw) as Index) : null
    if (parsed?.version === 1 && Array.isArray(parsed.entries)) {
      const holds: Record<string, string[]> = {}
      for (const [holder, keys] of Object.entries(parsed.holds ?? {})) {
        const list = Array.isArray(keys) ? keyList(keys) : []
        if (holder && list.length) holds[holder] = list
      }
      return {
        version: 1,
        entries: parsed.entries.filter(
          (entry) =>
            normalizeIssuerIdentityKey(entry?.identityKey) === entry.identityKey && Number.isFinite(entry.storedAt),
        ),
        ...(Object.keys(holds).length ? { holds } : {}),
      }
    }
  } catch {
    /* rebuilt below */
  }
  return { version: 1, entries: [] }
}

function writeIndex(chain: Chain, index: Index): boolean {
  return durableSetItem(indexKey(chain), JSON.stringify(index))
}

function evict(chain: Chain, index: Index): Index {
  const held = new Set(Object.values(index.holds ?? {}).flat())
  const strangers = index.entries
    .map((entry, at) => ({ entry, at }))
    .filter(({ entry }) => !entry.pinned && !held.has(entry.identityKey))
    .sort((a, b) => b.entry.storedAt - a.entry.storedAt || b.at - a.at)
  const dropped = new Set(strangers.slice(MAX_UNHELD).map(({ entry }) => entry.identityKey))
  for (const key of dropped) {
    durableRemoveItem(entryKey(chain, key))
    decoded.delete(`${chain}:${key}`)
  }
  if (dropped.size > 0)
    console.info(`[identity] evicted ${dropped.size} profile(s) no contact or held asset names`)
  return { ...index, entries: index.entries.filter((entry) => !dropped.has(entry.identityKey)) }
}

function readStored(chain: Chain, identityKey: string): StoredProfile | null {
  try {
    const raw = durableGetItem(entryKey(chain, identityKey))
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<StoredProfile> & { record?: { certificate?: unknown; image?: PackageImage } }
    const certificate = parseProfileCertificate(value.record?.certificate)
    if (
      !certificate ||
      certificate.certifier !== identityKey ||
      typeof value.name !== 'string' ||
      !value.name ||
      value.name.length > IDENTITY_NAME_MAX ||
      typeof value.description !== 'string' ||
      value.description.length > IDENTITY_DESCRIPTION_MAX ||
      typeof value.issuedAt !== 'string'
    )
      return null
    const image = value.record?.image
    return {
      record: { certificate, ...(image ? { image } : {}) },
      name: value.name,
      description: value.description,
      issuedAt: value.issuedAt,
    }
  } catch {
    return null
  }
}

/**
 * Record every identity key a persisted list names, replacing what that list
 * named before. `holder` is the list's own durable key. Held profiles are
 * never evicted.
 */
export function holdIdentityProfiles(chain: Chain, holder: string, names: Iterable<unknown>): void {
  if (!holder) return
  const keys = keyList(names)
  const index = readIndex(chain)
  const prior = index.holds?.[holder] ?? []
  if (prior.length === keys.length && prior.every((key, i) => key === keys[i])) return
  const holds = { ...index.holds }
  if (keys.length) holds[holder] = keys
  else delete holds[holder]
  writeIndex(chain, { version: 1, entries: index.entries, ...(Object.keys(holds).length ? { holds } : {}) })
}

/** The verified profile `identityKey` published, as this device holds it. */
export function identityProfileFor(chain: Chain, identityKey: string | null | undefined): IdentityProfile | null {
  const key = normalizeIssuerIdentityKey(identityKey)
  if (!key) return null
  const memo = `${chain}:${key}`
  if (decoded.has(memo)) return decoded.get(memo) ?? null
  const stored = readStored(chain, key)
  const image = stored?.record.image ? packageImageBytes(stored.record.image) : null
  const profile: IdentityProfile | null =
    stored && (!stored.record.image || image)
      ? {
          identityKey: key,
          name: stored.name,
          description: stored.description,
          issuedAt: stored.issuedAt,
          ...(image ? { image } : {}),
        }
      : null
  decoded.set(memo, profile)
  return profile
}

/** The signed certificate and image behind `identityKey`'s profile, to hand to a peer. */
export function identityProfileRecord(chain: Chain, identityKey: string): IdentityProfileRecord | null {
  const key = normalizeIssuerIdentityKey(identityKey)
  return key ? (readStored(chain, key)?.record ?? null) : null
}

/** Every profile this device holds. */
export function storedIdentityProfiles(chain: Chain): IdentityProfile[] {
  return readIndex(chain).entries.flatMap((entry) => identityProfileFor(chain, entry.identityKey) ?? [])
}

/**
 * Keep a verified profile unless this device already holds one at least as
 * new. `pin` marks a key this wallet controls. True when the profile is held
 * after the call.
 */
export function rememberIdentityProfile(
  chain: Chain,
  verified: { record: IdentityProfileRecord; profile: IdentityProfile },
  opts?: { pin?: boolean },
): boolean {
  const key = verified.profile.identityKey
  const index = readIndex(chain)
  const prior = index.entries.find((entry) => entry.identityKey === key)
  const stored = prior ? readStored(chain, key) : null
  const newer = !stored || verified.profile.issuedAt > stored.issuedAt
  const pinned = !!(opts?.pin || prior?.pinned)
  if (!newer && pinned === !!prior?.pinned) return stored?.issuedAt === verified.profile.issuedAt
  if (newer) {
    const value: StoredProfile = {
      record: verified.record,
      name: verified.profile.name,
      description: verified.profile.description,
      issuedAt: verified.profile.issuedAt,
    }
    if (!durableSetItem(entryKey(chain, key), JSON.stringify(value))) return false
  }
  const next = evict(chain, {
    ...index,
    entries: [
      ...index.entries.filter((entry) => entry.identityKey !== key),
      { identityKey: key, storedAt: prior?.storedAt ?? Date.now(), ...(pinned ? { pinned: true as const } : {}) },
    ],
  })
  if (!writeIndex(chain, next)) return false
  decoded.delete(`${chain}:${key}`)
  announce()
  return true
}

export function resetIdentityProfilesForTests(): void {
  decoded.clear()
  generation = 0
}
