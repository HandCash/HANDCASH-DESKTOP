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

export type SearchSuggestion = {
  /** Text added as a filter term when picked. */
  term: string
  label: string
  /** What the term is: a trait's name, "Name" or "App". */
  kind: string
  /** Items that would remain with this term added. */
  count: number
}

function nameStem(name: string): string {
  return name.replace(/\s*#?\s*\d+\s*$/, '').trim()
}

/**
 * Terms worth adding next, counted against what the current terms leave.
 * With a draft, candidates contain it (prefix matches first); without one,
 * the commonest traits that still narrow the list.
 */
export function suggestCollectableTerms(
  draft: string,
  terms: readonly string[],
  items: readonly Collectable[],
  limit = 6,
): SearchSuggestion[] {
  const needle = draft.trim().toLowerCase()
  const applied = new Set(terms.map((t) => t.trim().toLowerCase()))
  const base = searchCollectables(terms.join(','), items)
  const found = new Map<string, SearchSuggestion>()

  const offer = (term: string, label: string, kind: string) => {
    const key = term.trim().toLowerCase()
    if (!key || applied.has(key) || found.has(key)) return
    if (needle && !label.toLowerCase().includes(needle) && !key.includes(needle)) return
    found.set(key, { term: term.trim(), label: label.trim(), kind, count: 0 })
  }

  for (const item of base) {
    for (const trait of [...item.traits, ...item.extras]) {
      if (trait.name && trait.value) offer(`${trait.name} ${trait.value}`, trait.value, trait.name)
    }
    const stem = nameStem(item.name)
    if (stem) offer(stem, stem, 'Name')
    if (needle && item.name && item.name !== stem) offer(item.name, item.name, 'Name')
    if (item.app) offer(item.app, item.app, 'App')
  }

  const blobs = base.map(collectableSearchBlob)
  const out: SearchSuggestion[] = []
  for (const [key, suggestion] of found) {
    suggestion.count = blobs.reduce((n, blob) => (blob.includes(key) ? n + 1 : n), 0)
    if (suggestion.count === 0) continue
    if (!needle && suggestion.count === base.length) continue
    out.push(suggestion)
  }

  const starts = (s: SearchSuggestion) =>
    needle && s.label.toLowerCase().startsWith(needle) ? 0 : 1
  out.sort(
    (a, b) =>
      starts(a) - starts(b) ||
      b.count - a.count ||
      a.label.length - b.label.length ||
      a.label.localeCompare(b.label),
  )
  return out.slice(0, limit)
}
