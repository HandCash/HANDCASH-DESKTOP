import type { Collectable } from './collectables'

/**
 * Collect hierarchy is issuer → collection → items.
 *
 * `app` is the issuer axis. `collectionId` (BRC-99 `collection:<id>`) is the
 * set. Items without an issuer still nest under a collection shelf when they
 * have an id; only tips with neither sit in `ungrouped`.
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
  collections: CollectableGroup[]
  loose: Collectable[]
  items: Collectable[]
  faces: CollectableFace[]
  overflow: number
  quantity: number
  provenCount: number
}

export type GroupedCollectables = {
  issuers: CollectableIssuer[]
  ungrouped: Collectable[]
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

function issuerKeyFor(item: Collectable): { key: string; label: string; app?: string } | null {
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

export function groupCollectables(items: Collectable[]): GroupedCollectables {
  const issuerBuckets = new Map<
    string,
    { meta: { key: string; label: string; app?: string }; items: Collectable[] }
  >()
  const ungrouped: Collectable[] = []

  for (const item of items) {
    const meta = issuerKeyFor(item)
    if (!meta) {
      ungrouped.push(item)
      continue
    }
    const bucket = issuerBuckets.get(meta.key)
    if (bucket) bucket.items.push(item)
    else issuerBuckets.set(meta.key, { meta, items: [item] })
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

    const { faces, overflow } = facesFor(bucket.items)
    issuers.push({
      key: bucket.meta.key,
      label: bucket.meta.label,
      ...(bucket.meta.app ? { app: bucket.meta.app } : {}),
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
  return { issuers, ungrouped, groups, singles: [] }
}

export function groupQuantityLabel(group: {
  quantity: number
  provenCount: number
}): string {
  const quantity = `${group.quantity.toLocaleString()} ${group.quantity === 1 ? 'item' : 'items'}`
  if (group.provenCount === 0) return quantity
  return `${quantity} · ${group.provenCount.toLocaleString()} verified`
}
