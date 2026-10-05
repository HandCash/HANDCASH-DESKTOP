import type { ChainTracker } from '@bsv/sdk'
import { storageRegistry } from '../storage/registry'
import { durableGetItem, durableRemoveItem, durableSetItem } from './durableStorage'
import {
  buildIssuerIdentityPackage,
  issuerIdentityPackageBeef,
  issuerIdentityPackageRoots,
  issuerSignerVerdict,
  parseIssuerIdentityPackage,
  verifyIssuerIdentityPackage,
  type IssuerAttribution,
  type IssuerIdentity,
  type IssuerIdentityPackage,
} from './issuerIdentity'
import { normalizeBapId } from './issuerMetadata'
import type { Chain } from './vault'

/**
 * Identity packages, one per BAP ID, shared by every asset that names it.
 * Assets carry only the BAP ID inside their signed tape; the package travels
 * beside a delivery when the receiver needs it.
 *
 * A peer's newer package merges into the stored one, and the merge keeps the
 * first key rotation on chain, so a leaked retired key cannot fork the chain
 * by sending a package of its own. Identities this wallet controls are pinned:
 * only this wallet's publish, rotate and proof-upgrade flows rewrite them.
 *
 * Each package holds an image of up to 64 KB, and Mobile's store can be
 * synchronous localStorage, so every package has its own key. A package that a
 * contact or a held asset names is held and never evicted; only packages
 * nothing on this device names are capped.
 */

type IndexEntry = { bapId: string; storedAt: number; pinned?: true }
/** `holds` maps a persisted list's durable key to the BAP IDs it names. */
type Index = { version: 1; entries: IndexEntry[]; holds?: Record<string, string[]> }

const MAX_UNHELD = 8
const BASE = storageRegistry.issuerIdentities.key
const indexKey = (chain: Chain) => `${BASE}:${chain}`
const entryKey = (chain: Chain, bapId: string) => `${BASE}:${chain}:${bapId}`

const verified = new Map<string, IssuerIdentity | null>()
const listeners = new Set<() => void>()
let generation = 0

export function subscribeIssuerIdentities(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function issuerIdentitiesGeneration(): number {
  return generation
}

function announce() {
  generation++
  for (const listener of listeners) listener()
}

function bapIdList(raw: Iterable<unknown>): string[] {
  const ids = new Set<string>()
  for (const value of new Set(raw)) {
    const id = normalizeBapId(value)
    if (id) ids.add(id)
  }
  return [...ids].sort()
}

function readHolds(raw: unknown): Record<string, string[]> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const holds: Record<string, string[]> = {}
  for (const [holder, ids] of Object.entries(raw as Record<string, unknown>)) {
    const list = Array.isArray(ids) ? bapIdList(ids) : []
    if (holder && list.length) holds[holder] = list
  }
  return Object.keys(holds).length ? holds : undefined
}

function readIndex(chain: Chain): Index {
  try {
    const raw = durableGetItem(indexKey(chain))
    const parsed = raw ? (JSON.parse(raw) as Index) : null
    if (parsed?.version === 1 && Array.isArray(parsed.entries)) {
      const holds = readHolds(parsed.holds)
      return {
        version: 1,
        entries: parsed.entries.filter(
          (entry) => normalizeBapId(entry?.bapId) === entry.bapId && Number.isFinite(entry.storedAt),
        ),
        ...(holds ? { holds } : {}),
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
  // Entries are appended as they arrive, so position breaks a same-millisecond tie.
  const strangers = index.entries
    .map((entry, at) => ({ entry, at }))
    .filter(({ entry }) => !entry.pinned && !held.has(entry.bapId))
    .sort((a, b) => b.entry.storedAt - a.entry.storedAt || b.at - a.at)
  const dropped = new Set(strangers.slice(MAX_UNHELD).map(({ entry }) => entry.bapId))
  for (const bapId of dropped) {
    durableRemoveItem(entryKey(chain, bapId))
    verified.delete(`${chain}:${bapId}`)
  }
  if (dropped.size > 0)
    console.info(`[identity] evicted ${dropped.size} identity package(s) no contact or held asset names`)
  return { ...index, entries: index.entries.filter((entry) => !dropped.has(entry.bapId)) }
}

/**
 * Record every BAP ID a persisted list names, replacing what that list named
 * before. `holder` is the list's own durable key, so each account's contacts,
 * tokens and items hold for themselves. Held packages are never evicted.
 */
export function holdIssuerIdentities(chain: Chain, holder: string, bapIds: Iterable<unknown>): void {
  if (!holder) return
  const ids = bapIdList(bapIds)
  const index = readIndex(chain)
  const prior = index.holds?.[holder] ?? []
  if (prior.length === ids.length && prior.every((id, i) => id === ids[i])) return
  const holds = { ...index.holds }
  if (ids.length) holds[holder] = ids
  else delete holds[holder]
  writeIndex(chain, {
    version: 1,
    entries: index.entries,
    ...(Object.keys(holds).length ? { holds } : {}),
  })
}

export function issuerIdentityPackage(chain: Chain, bapId: string): IssuerIdentityPackage | null {
  const id = normalizeBapId(bapId)
  if (!id) return null
  try {
    const raw = durableGetItem(entryKey(chain, id))
    const pkg = raw ? parseIssuerIdentityPackage(JSON.parse(raw)) : null
    return pkg?.bapId === id ? pkg : null
  } catch {
    return null
  }
}

/** Verified identity, read and checked once per session. */
export function issuerIdentityFor(chain: Chain, bapId: string): IssuerIdentity | null {
  const id = normalizeBapId(bapId)
  if (!id) return null
  const key = `${chain}:${id}`
  if (verified.has(key)) return verified.get(key) ?? null
  const identity = verifyIssuerIdentityPackage(issuerIdentityPackage(chain, id))
  const valid = identity?.bapId === id ? identity : null
  if (valid) verified.set(key, valid)
  return valid
}

/** Every verified identity this device holds a package for. */
export function storedIssuerIdentities(chain: Chain): IssuerIdentity[] {
  return readIndex(chain).entries.flatMap((entry) => {
    const identity = issuerIdentityFor(chain, entry.bapId)
    return identity ? [identity] : []
  })
}

/** Whether `signer` spoke for the stamped BAP ID when it signed an asset mined at `minedHeight`. */
export function issuerAttribution(
  chain: Chain,
  claim: { bapId: string; signer: string; minedHeight?: number },
): IssuerAttribution | null {
  const bapId = normalizeBapId(claim.bapId)
  if (!bapId) return null
  const identity = issuerIdentityFor(chain, bapId)
  if (!identity) return { kind: 'unconfirmed', bapId, reason: 'no-package' }
  const verdict = issuerSignerVerdict(identity, claim.signer, claim.minedHeight)
  if (verdict === 'active') return { kind: 'verified', identity }
  if (verdict === 'unknown-key') return { kind: 'unconfirmed', bapId, reason: 'unknown-key' }
  if (verdict === 'retired-key' && claim.minedHeight === undefined)
    return { kind: 'unconfirmed', bapId, reason: 'height-unknown' }
  return { kind: 'refused', bapId, reason: verdict }
}

/** The identity `signer` spoke for when it signed an asset mined at `minedHeight`. */
export function issuerIdentityForSigner(
  chain: Chain,
  claim: { bapId: string; signer: string; minedHeight?: number },
): IssuerIdentity | null {
  const attribution = issuerAttribution(chain, claim)
  return attribution?.kind === 'verified' ? attribution.identity : null
}

/**
 * Verify and keep a package. `replace` stores a package this wallet built as
 * is (its own publish may prefer an unmined ALIAS); otherwise the incoming
 * package merges with the stored one. Null when nothing verified or saved.
 */
export function rememberIssuerIdentityPackage(
  chain: Chain,
  raw: unknown,
  opts?: { pin?: boolean; replace?: boolean },
): IssuerIdentity | null {
  const incoming = parseIssuerIdentityPackage(raw)
  if (!incoming || !verifyIssuerIdentityPackage(incoming)) return null
  const bapId = incoming.bapId
  const index = readIndex(chain)
  const prior = index.entries.find((entry) => entry.bapId === bapId)
  if (prior?.pinned && !opts?.pin) return issuerIdentityFor(chain, bapId)
  const stored = prior ? issuerIdentityPackage(chain, bapId) : null
  let pkg = incoming
  if (stored && !opts?.replace)
    pkg =
      buildIssuerIdentityPackage(bapId, [
        issuerIdentityPackageBeef(stored),
        issuerIdentityPackageBeef(incoming),
      ]) ?? stored
  else if (!opts?.replace)
    pkg = buildIssuerIdentityPackage(bapId, [issuerIdentityPackageBeef(incoming)]) ?? incoming
  const identity = verifyIssuerIdentityPackage(pkg)
  if (!identity) return null
  const changed = pkg.beefB64 !== stored?.beefB64
  if (changed && !durableSetItem(entryKey(chain, bapId), JSON.stringify(pkg))) return null
  const pinned = !!(opts?.pin || prior?.pinned)
  if (prior && !changed && pinned === !!prior.pinned) return issuerIdentityFor(chain, bapId)
  const next = evict(chain, {
    ...index,
    entries: [
      ...index.entries.filter((entry) => entry.bapId !== bapId),
      { bapId, storedAt: prior?.storedAt ?? Date.now(), ...(pinned ? { pinned: true as const } : {}) },
    ],
  })
  if (!writeIndex(chain, next)) return null
  verified.set(`${chain}:${bapId}`, identity)
  announce()
  return identity
}

/**
 * A peer's package, kept only once every merkle proof in it matches a block
 * header: heights decide key rotation and revocation, so a forged proof must
 * never reach the store.
 */
export async function rememberConfirmedIssuerIdentityPackage(
  chain: Chain,
  raw: unknown,
  tracker: ChainTracker | null | undefined,
): Promise<IssuerIdentity | null> {
  const roots = issuerIdentityPackageRoots(raw)
  if (!roots) return null
  if (roots.length) {
    if (!tracker) return null
    try {
      for (const { root, height } of roots)
        if (!(await tracker.isValidRootForHeight(root, height))) return null
    } catch {
      return null
    }
  }
  return rememberIssuerIdentityPackage(chain, raw)
}

export function resetIssuerIdentitiesForTests(): void {
  verified.clear()
  generation = 0
}
