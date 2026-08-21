import type { Collectable } from './collectables'

/**
 * Collect groups items by collection so a 200-tip wallet reads as a shelf of
 * sets rather than a wall of thumbnails.
 *
 * Grouping is display-only: the key is the item's own `collectionId` (BRC-99
 * `collection:<id>` scope), and `app` is the fallback axis for items minted
 * without one. A group of one is not a collection worth folding, so those items
 * fall back through to `loose` and paint exactly as they do today.
 */

/** Faces shown before the pile collapses into a "+N" chip. */
export const FACE_LIMIT = 4
/** Below this a "collection" is just an item, so it is not folded. */
const MIN_GROUP_SIZE = 2

export type CollectableFace = {
  outpoint: string
  imageUrl: string
  name: string
}

export type CollectableGroup = {
  /** Stable React key and Accordion value. */
  key: string
  collectionId?: string
  app?: string
  /** Display heading, disambiguated when two groups would read the same. */
  label: string
  items: Collectable[]
  faces: CollectableFace[]
  /** Items beyond the facepile, for the "+N" chip. */
  overflow: number
  quantity: number
  /** How many carry a complete BRC-150 tip→origin proof. */
  provenCount: number
}

export type GroupedCollectables = {
  groups: CollectableGroup[]
  /** Items with no collection axis, or the only member of theirs. */
  loose: Collectable[]
}

function shortId(value: string): string {
  return value.length > 10 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value
}

function axisFor(item: Collectable): { key: string; collectionId?: string; app?: string } | null {
  if (item.collectionId) {
    return {
      key: `collection:${item.collectionId.toLowerCase()}`,
      collectionId: item.collectionId,
      app: item.app,
    }
  }
  if (item.app) return { key: `app:${item.app.toLowerCase()}`, app: item.app }
  return null
}

function baseLabel(axis: { collectionId?: string; app?: string }): string {
  if (axis.app) return axis.app
  if (axis.collectionId) return `Collection ${shortId(axis.collectionId)}`
  return 'Collection'
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

export function groupCollectables(items: Collectable[]): GroupedCollectables {
  const buckets = new Map<
    string,
    { axis: { key: string; collectionId?: string; app?: string }; items: Collectable[] }
  >()
  const loose: Collectable[] = []

  for (const item of items) {
    const axis = axisFor(item)
    if (!axis) {
      loose.push(item)
      continue
    }
    const bucket = buckets.get(axis.key)
    if (bucket) bucket.items.push(item)
    else buckets.set(axis.key, { axis, items: [item] })
  }

  const groups: CollectableGroup[] = []
  for (const bucket of buckets.values()) {
    if (bucket.items.length < MIN_GROUP_SIZE) {
      loose.push(...bucket.items)
      continue
    }
    const { faces, overflow } = facesFor(bucket.items)
    groups.push({
      key: bucket.axis.key,
      ...(bucket.axis.collectionId ? { collectionId: bucket.axis.collectionId } : {}),
      ...(bucket.axis.app ? { app: bucket.axis.app } : {}),
      label: baseLabel(bucket.axis),
      items: bucket.items,
      faces,
      overflow,
      quantity: bucket.items.length,
      provenCount: bucket.items.filter((item) => item.proven).length,
    })
  }

  // Two collections from one app would otherwise both read as the app name.
  const labelCounts = new Map<string, number>()
  for (const group of groups) {
    labelCounts.set(group.label, (labelCounts.get(group.label) ?? 0) + 1)
  }
  for (const group of groups) {
    if ((labelCounts.get(group.label) ?? 0) < 2) continue
    const suffix = group.collectionId ?? group.app
    if (suffix) group.label = `${group.label} · ${shortId(suffix)}`
  }

  groups.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }))
  return { groups, loose }
}

/** Card subtitle: "12 items", plus verified count once any are proven. */
export function groupQuantityLabel(group: CollectableGroup): string {
  const quantity = `${group.quantity.toLocaleString()} ${group.quantity === 1 ? 'item' : 'items'}`
  if (group.provenCount === 0) return quantity
  return `${quantity} · ${group.provenCount.toLocaleString()} verified`
}
