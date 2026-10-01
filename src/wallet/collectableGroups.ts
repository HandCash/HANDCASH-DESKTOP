import {
  verifyPublicIdentityProfile,
  type PublicIdentityProfile,
} from './publicIdentityProfile'
import type { Collectable } from './collectables'
import { normalizeIssuerPubKey, shortIssuerLabel } from './token/issuer'
import type { FungibleToken } from './token/types'

/**
 * Collect hierarchy is issuer → collections → assets. Identity-backed tokens
 * are keyed by their normalized issuer public key; handles are display only.
 * Label-only item shelves stay separate and cannot impersonate a keyed issuer.
 * Grouping is presentation, not signature verification or transfer policy.
 * This remains applicable to transferable assets, identity records and awards.
 */

export const FACE_LIMIT = 4

export type CollectableFace = {
  outpoint: string
  imageUrl: string
  name: string
}

export type CollectableGroup = {
  key: string
  collectionId?: string
  app?: string
  label: string
  items: Collectable[]
  faces: CollectableFace[]
  overflow: number
  quantity: number
  provenCount: number
}

export type CollectableIssuer = {
  /** Stable shelf identity; never derived from a handle when an issuer key exists. */
  key: string
  /** Attribution key from the asset record; presence does not certify its signature. */
  identityKey?: string
  icon?: string
  issuerAttested?: boolean
  profileChain?: 'main' | 'test'
  label: string
  app?: string
  /** Fungibles this identity issued — one horizontal shelf. */
  tokens: FungibleToken[]
  collections: CollectableGroup[]
  loose: Collectable[]
  /** One-sat items only; `tokens` are not repeated here. */
  items: Collectable[]
  faces: CollectableFace[]
  overflow: number
  quantity: number
  provenCount: number
}

export type GroupedCollectables = {
  issuers: CollectableIssuer[]
  ungrouped: Collectable[]
  /** Fungibles whose issuer is unknown — shown on a top shelf. */
  ungroupedTokens: FungibleToken[]
  /** Flattened collections (every size, including one). */
  groups: CollectableGroup[]
  /** Always empty — one-item collections stay under their issuer. */
  singles: Collectable[]
}

function shortId(value: string): string {
  return value.length > 10 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value
}

export function collectionSeriesLabel(
  items: readonly Collectable[],
): string | null {
  const stems = items
    .map((item) => item.name.replace(/\s*#\d+\s*$/u, '').trim())
    .filter(Boolean)
  if (stems.length === 0) return null
  const first = stems[0]!
  if (stems.every((stem) => stem.toLowerCase() === first.toLowerCase()))
    return first
  return null
}

function facesFor(items: Collectable[]): {
  faces: CollectableFace[]
  overflow: number
} {
  const faces: CollectableFace[] = []
  const seen = new Set<string>()
  for (const item of items) {
    if (faces.length >= FACE_LIMIT) break
    if (!item.imageUrl || seen.has(item.imageUrl)) continue
    seen.add(item.imageUrl)
    faces.push({
      outpoint: item.outpoint,
      imageUrl: item.imageUrl,
      name: item.name,
    })
  }
  return { faces, overflow: Math.max(0, items.length - faces.length) }
}

function collectionLabel(items: Collectable[], collectionId: string): string {
  return collectionSeriesLabel(items) ?? `Collection ${shortId(collectionId)}`
}

function makeGroup(args: {
  key: string
  items: Collectable[]
  collectionId?: string
  app?: string
  label: string
}): CollectableGroup {
  const { faces, overflow } = facesFor(args.items)
  return {
    key: args.key,
    ...(args.collectionId ? { collectionId: args.collectionId } : {}),
    ...(args.app ? { app: args.app } : {}),
    label: args.label,
    items: args.items,
    faces,
    overflow,
    quantity: args.items.length,
    provenCount: args.items.filter((item) => item.proven).length,
  }
}

type IssuerMeta = {
  key: string
  label: string
  app?: string
  identityKey?: string
  issuerAttested?: boolean
}

function issuerKeyFor(item: Collectable): IssuerMeta | null {
  const issuer = normalizeIssuerPubKey(item.issuer)
  if (issuer)
    return {
      key: `issuer:${item.issuerAttested ? 'pubkey' : 'claim'}:${issuer}`,
      identityKey: issuer,
      issuerAttested: !!item.issuerAttested,
      label: item.issuerAttested
        ? shortIssuerLabel(issuer)
        : `Issuer claim ${shortIssuerLabel(issuer)}`,
    }
  const app = item.app?.trim()
  if (app) return { key: `issuer:app:${app.toLowerCase()}`, label: app, app }
  if (item.collectionId?.trim()) {
    return {
      key: `issuer:collection:${item.collectionId.toLowerCase()}`,
      label:
        collectionSeriesLabel([item]) ??
        `Collection ${shortId(item.collectionId)}`,
    }
  }
  return null
}

/** Human labels may change; the issuer key determines the shelf. */
function tokenIssuerKeyFor(token: FungibleToken): IssuerMeta | null {
  const issuer = normalizeIssuerPubKey(token.issuer)
  if (!issuer) return null
  return {
    key: `issuer:${token.issuerAttested ? 'pubkey' : 'claim'}:${issuer}`,
    identityKey: issuer,
    issuerAttested: !!token.issuerAttested,
    // Handle certificate verification belongs to profile resolution. Until
    // then, a cached handle must not label an identity-backed issuer shelf.
    label: token.issuerAttested
      ? shortIssuerLabel(issuer)
      : `Issuer claim ${shortIssuerLabel(issuer)}`,
  }
}

function tokenFaces(
  tokens: readonly FungibleToken[],
  seen: Set<string>,
): CollectableFace[] {
  const faces: CollectableFace[] = []
  for (const token of tokens) {
    if (!token.iconUrl || seen.has(token.iconUrl)) continue
    seen.add(token.iconUrl)
    faces.push({
      outpoint: token.outpoint,
      imageUrl: token.iconUrl,
      name: token.sym,
    })
  }
  return faces
}

export function groupCollectables(
  items: Collectable[],
  tokens: readonly FungibleToken[] = [],
  profiles: readonly PublicIdentityProfile[] = [],
): GroupedCollectables {
  const issuerBuckets = new Map<
    string,
    { meta: IssuerMeta; items: Collectable[]; tokens: FungibleToken[] }
  >()
  const ungrouped: Collectable[] = []
  const ungroupedTokens: FungibleToken[] = []

  for (const item of items) {
    const meta = issuerKeyFor(item)
    if (!meta) {
      ungrouped.push(item)
      continue
    }
    const bucket = issuerBuckets.get(meta.key)
    if (bucket) bucket.items.push(item)
    else issuerBuckets.set(meta.key, { meta, items: [item], tokens: [] })
  }

  for (const token of tokens) {
    const meta = tokenIssuerKeyFor(token)
    if (!meta) {
      ungroupedTokens.push(token)
      continue
    }
    const bucket = issuerBuckets.get(meta.key)
    if (bucket) {
      bucket.tokens.push(token)
    } else issuerBuckets.set(meta.key, { meta, items: [], tokens: [token] })
  }

  const issuers: CollectableIssuer[] = []
  const groups: CollectableGroup[] = []

  for (const bucket of issuerBuckets.values()) {
    const byCollection = new Map<string, Collectable[]>()
    const loose: Collectable[] = []
    for (const item of bucket.items) {
      const id = item.collectionId?.trim()
      if (!id) {
        loose.push(item)
        continue
      }
      const list = byCollection.get(id.toLowerCase())
      if (list) list.push(item)
      else byCollection.set(id.toLowerCase(), [item])
    }

    const collections: CollectableGroup[] = []
    for (const [id, collectionItems] of byCollection) {
      const group = makeGroup({
        key: `${bucket.meta.key}|collection:${id}`,
        items: collectionItems,
        collectionId: collectionItems[0]?.collectionId,
        app: bucket.meta.app,
        label: collectionLabel(
          collectionItems,
          collectionItems[0]?.collectionId ?? id,
        ),
      })
      collections.push(group)
      groups.push(group)
    }
    collections.sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }),
    )

    // Items lead the facepile; token icons fill the remaining slots so a
    // tokens-only issuer still has a face.
    const seenFaces = new Set(
      bucket.items.map((item) => item.imageUrl).filter(Boolean),
    )
    const { faces: itemFaces } = facesFor(bucket.items)
    const faces = [...itemFaces, ...tokenFaces(bucket.tokens, seenFaces)].slice(
      0,
      FACE_LIMIT,
    )
    const overflow = Math.max(
      0,
      bucket.items.length + bucket.tokens.length - faces.length,
    )
    bucket.tokens.sort((a, b) =>
      a.sym.localeCompare(b.sym, undefined, { sensitivity: 'base' }),
    )
    const publicProfile =
      bucket.meta.identityKey && bucket.meta.issuerAttested
        ? [
            ...profiles,
            ...bucket.items.map((item) => item.issuerProfile),
            ...bucket.tokens.map((token) => token.issuerProfile),
          ]
            .map((profile) =>
              verifyPublicIdentityProfile(profile, bucket.meta.identityKey),
            )
            .filter((profile): profile is PublicIdentityProfile => !!profile)
            .sort((a, b) => b.updatedAt - a.updatedAt)[0]
        : undefined
    issuers.push({
      key: bucket.meta.key,
      label: publicProfile?.displayName ?? bucket.meta.label,
      ...(publicProfile
        ? { icon: publicProfile.icon, profileChain: publicProfile.chain }
        : {}),
      ...(bucket.meta.identityKey
        ? {
            identityKey: bucket.meta.identityKey,
            issuerAttested: bucket.meta.issuerAttested,
          }
        : {}),
      ...(bucket.meta.app ? { app: bucket.meta.app } : {}),
      tokens: bucket.tokens,
      collections,
      loose,
      items: bucket.items,
      faces,
      overflow,
      quantity: bucket.items.length,
      provenCount: bucket.items.filter((item) => item.proven).length,
    })
  }

  issuers.sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }),
  )
  return { issuers, ungrouped, ungroupedTokens, groups, singles: [] }
}

export function groupQuantityLabel(group: {
  quantity: number
  provenCount: number
  tokens?: readonly unknown[]
}): string {
  const parts: string[] = []
  const tokenCount = group.tokens?.length ?? 0
  if (tokenCount > 0) {
    parts.push(
      `${tokenCount.toLocaleString()} ${tokenCount === 1 ? 'token' : 'tokens'}`,
    )
  }
  if (group.quantity > 0 || tokenCount === 0) {
    parts.push(
      `${group.quantity.toLocaleString()} ${group.quantity === 1 ? 'item' : 'items'}`,
    )
  }
  if (group.provenCount > 0)
    parts.push(`${group.provenCount.toLocaleString()} verified`)
  return parts.join(' · ')
}
