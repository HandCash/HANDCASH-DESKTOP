import type { Collectable } from './collectables'
import { shortIssuerLabel } from './token/issuer'
import type { FungibleToken } from './token/types'

/**
 * Collect hierarchy is issuer identity → tokens → collection → items.
 *
 * `app` is the issuer axis for one-sat items; a fungible's `issuerHandle`
 * (or, failing that, its issuer pubkey) is the same axis, so a `$handle`
 * that minted both a token and a set shows once, with its fungibles on one
 * shelf and its items under it. `collectionId` (BRC-99 `collection:<id>`) is
 * the set. Items without an issuer still nest under a collection shelf when
 * they have an id; only tips with neither sit in `ungrouped`, and tokens
 * with no issuer at all sit in `ungroupedTokens`.
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
  key: string
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

export function collectionSeriesLabel(items: readonly Collectable[]): string | null {
  const stems = items
    .map((item) => item.name.replace(/\s*#\d+\s*$/u, '').trim())
    .filter(Boolean)
  if (stems.length === 0) return null
  const first = stems[0]!
  if (stems.every((stem) => stem.toLowerCase() === first.toLowerCase())) return first
  return null
}

function facesFor(items: Collectable[]): { faces: CollectableFace[]; overflow: number } {
  const faces: CollectableFace[] = []
  const seen = new Set<string>()
  for (const item of items) {
    if (faces.length >= FACE_LIMIT) break
    if (!item.imageUrl || seen.has(item.imageUrl)) continue
    seen.add(item.imageUrl)
    faces.push({ outpoint: item.outpoint, imageUrl: item.imageUrl, name: item.name })
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

type IssuerMeta = { key: string; label: string; app?: string }

function issuerKeyFor(item: Collectable): IssuerMeta | null {
  const app = item.app?.trim()
  if (app) return { key: `issuer:${app.toLowerCase()}`, label: app, app }
  if (item.collectionId?.trim()) {
    return {
      key: `issuer:collection:${item.collectionId.toLowerCase()}`,
      label: collectionSeriesLabel([item]) ?? `Collection ${shortId(item.collectionId)}`,
    }
  }
  return null
}

/**
 * A fungible joins the issuer that shares its handle (the same `$handle` a
 * one-sat mint carries as `app`). With only a pubkey it still gets a shelf of
 * its own, keyed by that pubkey.
 */
function tokenIssuerKeyFor(token: FungibleToken): IssuerMeta | null {
  const handle = token.issuerHandle?.trim()
  if (handle) return { key: `issuer:${handle.toLowerCase()}`, label: handle, app: handle }
  const issuer = token.issuer?.trim()
  if (issuer) {
    return { key: `issuer:pubkey:${issuer.toLowerCase()}`, label: shortIssuerLabel(issuer) }
  }
  return null
}

function tokenFaces(tokens: readonly FungibleToken[], seen: Set<string>): CollectableFace[] {
  const faces: CollectableFace[] = []
  for (const token of tokens) {
    if (!token.iconUrl || seen.has(token.iconUrl)) continue
    seen.add(token.iconUrl)
    faces.push({ outpoint: token.outpoint, imageUrl: token.iconUrl, name: token.sym })
  }
  return faces
}

export function groupCollectables(
  items: Collectable[],
  tokens: readonly FungibleToken[] = [],
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
      // A handle-bearing token names the issuer when items only had a label.
      if (!bucket.meta.app && meta.app) bucket.meta = { ...bucket.meta, app: meta.app }
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
        label: collectionLabel(collectionItems, collectionItems[0]?.collectionId ?? id),
      })
      collections.push(group)
      groups.push(group)
    }
    collections.sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }),
    )

    // Items lead the facepile; token icons fill the remaining slots so a
    // tokens-only issuer still has a face.
    const seenFaces = new Set(bucket.items.map((item) => item.imageUrl).filter(Boolean))
    const { faces: itemFaces } = facesFor(bucket.items)
    const faces = [...itemFaces, ...tokenFaces(bucket.tokens, seenFaces)].slice(0, FACE_LIMIT)
    const overflow = Math.max(0, bucket.items.length + bucket.tokens.length - faces.length)
    bucket.tokens.sort((a, b) => a.sym.localeCompare(b.sym, undefined, { sensitivity: 'base' }))
    issuers.push({
      key: bucket.meta.key,
      label: bucket.meta.label,
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

  issuers.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }))
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
    parts.push(`${tokenCount.toLocaleString()} ${tokenCount === 1 ? 'token' : 'tokens'}`)
  }
  if (group.quantity > 0 || tokenCount === 0) {
    parts.push(`${group.quantity.toLocaleString()} ${group.quantity === 1 ? 'item' : 'items'}`)
  }
  if (group.provenCount > 0) parts.push(`${group.provenCount.toLocaleString()} verified`)
  return parts.join(' · ')
}
