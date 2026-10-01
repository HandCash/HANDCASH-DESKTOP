import {
  issuerIdentityImageDataUrl,
  type IssuerAttribution,
  type IssuerIdentity,
} from './issuerIdentity'
import type { Collectable } from './collectables'
import { normalizeIssuerPubKey, shortIssuerLabel } from './token/issuer'
import type { FungibleToken } from './token/types'

/**
 * Collect hierarchy is issuer → collections → assets. A signed asset that
 * names a BAP ID shelves under that BAP ID, so a key rotation keeps one shelf
 * labelled with the newest profile held; other signed assets are keyed by
 * their normalized issuer public key. Handles are display only.
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
  /** Image of the BAP identity the shelf's signers speak for. */
  icon?: string
  bapId?: string
  bapState?: IssuerBap['state']
  issuerAttested?: boolean
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

export type IssuerIdentityResolver = (asset: {
  issuer: string
  bapId?: string
  origin?: string
}) => IssuerAttribution | null

export type IssuerBap = {
  id: string
  state: 'verified' | 'unconfirmed'
  /** Newest profile the stored package proves; only on `verified`. */
  identity?: IssuerIdentity
}

/** How a signed asset's issuer reads everywhere in Collect: shelf, chip and details. */
export type IssuerView = {
  key: string
  label: string
  identityKey: string
  issuerAttested: boolean
  bap?: IssuerBap
}

/**
 * Every asset stamped with a BAP ID shares one shelf per BAP ID, across key
 * rotations. Verified signers show the identity; unconfirmed stamps get their
 * own BAP shelf with no name or image, because anyone can copy a stamp. A
 * signer the package retires or revokes keeps a shelf of its own key.
 */
export function issuerViewFor(
  asset: { issuer?: string; issuerAttested?: boolean; bapId?: string; origin?: string },
  identityFor: IssuerIdentityResolver,
): IssuerView | null {
  const issuer = normalizeIssuerPubKey(asset.issuer)
  if (!issuer) return null
  if (!asset.issuerAttested)
    return {
      key: `issuer:claim:${issuer}`,
      identityKey: issuer,
      issuerAttested: false,
      label: `Issuer claim ${shortIssuerLabel(issuer)}`,
    }
  const signed = { identityKey: issuer, issuerAttested: true }
  const attribution = identityFor({ issuer, bapId: asset.bapId, origin: asset.origin })
  if (attribution?.kind === 'verified' && (!asset.bapId || attribution.identity.bapId === asset.bapId)) {
    const { identity } = attribution
    return {
      ...signed,
      key: `issuer:bap:${identity.bapId}`,
      label: identity.name,
      bap: { id: identity.bapId, state: 'verified', identity },
    }
  }
  if (attribution?.kind === 'unconfirmed' && attribution.bapId === asset.bapId)
    return {
      ...signed,
      key: `issuer:bap-unconfirmed:${attribution.bapId}`,
      label: `Unconfirmed BAP ${shortId(attribution.bapId)}`,
      bap: { id: attribution.bapId, state: 'unconfirmed' },
    }
  return { ...signed, key: `issuer:pubkey:${issuer}`, label: shortIssuerLabel(issuer) }
}

type IssuerMeta = {
  key: string
  label: string
  app?: string
  identityKey?: string
  issuerAttested?: boolean
  bap?: IssuerBap
}

function issuerKeyFor(
  item: Collectable,
  identityFor: IssuerIdentityResolver,
): IssuerMeta | null {
  const keyed = issuerViewFor(item, identityFor)
  if (keyed) return keyed
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

/**
 * A cached handle is not certified by the token, so it never labels a shelf;
 * the deploy outpoint is the origin whose height judges the signer.
 */
export function tokenIssuerViewFor(
  token: FungibleToken,
  identityFor: IssuerIdentityResolver,
): IssuerView | null {
  return issuerViewFor({ ...token, origin: token.tokenId }, identityFor)
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
  identityFor: IssuerIdentityResolver = () => null,
): GroupedCollectables {
  const issuerBuckets = new Map<
    string,
    { meta: IssuerMeta; items: Collectable[]; tokens: FungibleToken[] }
  >()
  const ungrouped: Collectable[] = []
  const ungroupedTokens: FungibleToken[] = []

  for (const item of items) {
    const meta = issuerKeyFor(item, identityFor)
    if (!meta) {
      ungrouped.push(item)
      continue
    }
    const bucket = issuerBuckets.get(meta.key)
    if (bucket) bucket.items.push(item)
    else issuerBuckets.set(meta.key, { meta, items: [item], tokens: [] })
  }

  for (const token of tokens) {
    const meta = tokenIssuerViewFor(token, identityFor)
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
    const { bap } = bucket.meta
    issuers.push({
      key: bucket.meta.key,
      label: bucket.meta.label,
      ...(bap?.identity?.image
        ? { icon: issuerIdentityImageDataUrl(bap.identity.image) }
        : {}),
      ...(bap ? { bapId: bap.id, bapState: bap.state } : {}),
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
