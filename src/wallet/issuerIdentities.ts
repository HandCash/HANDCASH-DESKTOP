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
 * Each package holds an image of up to 64 KB, and Mobile's store is synchronous
 * localStorage, so every package has its own key and peers' packages are capped.
 */

type IndexEntry = { bapId: string; storedAt: number; pinned?: true }
type Index = { version: 1; entries: IndexEntry[] }

const MAX_UNPINNED = 8
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

function readIndex(chain: Chain): Index {
  try {
    const raw = durableGetItem(indexKey(chain))
    const parsed = raw ? (JSON.parse(raw) as Index) : null
    if (parsed?.version === 1 && Array.isArray(parsed.entries))
      return {
        version: 1,
        entries: parsed.entries.filter(
          (entry) => normalizeBapId(entry?.bapId) === entry.bapId && Number.isFinite(entry.storedAt),
        ),
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
  const unpinned = index.entries
    .filter((entry) => !entry.pinned)
    .sort((a, b) => b.storedAt - a.storedAt)
  const dropped = new Set(unpinned.slice(MAX_UNPINNED).map((entry) => entry.bapId))
  for (const bapId of dropped) {
    durableRemoveItem(entryKey(chain, bapId))
    verified.delete(`${chain}:${bapId}`)
  }
  return { version: 1, entries: index.entries.filter((entry) => !dropped.has(entry.bapId)) }
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

/** The identity `signer` spoke for when it signed an asset mined at `minedHeight`. */
export function issuerIdentityForSigner(
  chain: Chain,
  claim: { bapId: string; signer: string; minedHeight?: number },
): IssuerIdentity | null {
  const identity = issuerIdentityFor(chain, claim.bapId)
  return identity && issuerSignerVerdict(identity, claim.signer, claim.minedHeight) === 'active'
    ? identity
    : null
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
    version: 1,
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
