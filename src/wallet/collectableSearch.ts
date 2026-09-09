import type { Collectable } from './collectables'
import type { CollectableTrait } from './oneSatImport'

function traitHaystack(traits: CollectableTrait[]): string {
  return traits
    .map((t) => `${t.name ?? ''} ${t.value ?? ''}`.trim().toLowerCase())
    .filter(Boolean)
    .join(' ')
}

function collectableSearchBlob(item: Collectable): string {
  const parts = [
    item.name,
    item.origin,
    item.outpoint,
    item.collectionId,
    item.app,
    item.content,
    item.type,
    item.subType,
    item.mimeType,
    traitHaystack(item.traits),
    traitHaystack(item.extras),
  ]
  return parts
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    .join(' ')
    .toLowerCase()
}

/**
 * Friends/Connect-style search for Collect.
 * Comma-separated terms are AND filters (every term must match somewhere).
 * Matches name, origin, outpoint, collection, app, and trait name/value text.
 */
export function searchCollectables(
  query: string,
  items: readonly Collectable[],
): Collectable[] {
  const terms = query
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
  if (terms.length === 0) return [...items]
  return items.filter((item) => {
    const blob = collectableSearchBlob(item)
    return terms.every((term) => blob.includes(term))
  })
}
