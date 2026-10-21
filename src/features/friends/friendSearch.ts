import type { SearchSuggestion } from '../../wallet/collectableSearch'
import { searchFriends, type Friend } from '../../wallet/friends'

const MAX_SUGGESTIONS = 6

function applyTerms(friends: readonly Friend[], terms: readonly string[]): Friend[] {
  return terms.reduce((left, term) => searchFriends(term, left), [...friends])
}

/** Friends matching every comma-separated term by name or wallet key. */
export function filterFriends(friends: readonly Friend[], query: string): Friend[] {
  return applyTerms(friends, query.split(','))
}

/**
 * Names to offer while typing: friends left after the applied terms whose name
 * contains the draft, names starting with it first, at most six.
 */
export function suggestFriends(
  friends: readonly Friend[],
  typed: string,
  applied: readonly string[],
): SearchSuggestion[] {
  const needle = typed.trim().toLowerCase()
  if (!needle) return []
  const left = applyTerms(friends, applied)
  const startsWithNeedle = (f: Friend) => f.label.toLowerCase().startsWith(needle)
  return left
    .filter((f) => f.label.toLowerCase().includes(needle))
    .sort((a, b) => Number(!startsWithNeedle(a)) - Number(!startsWithNeedle(b)))
    .slice(0, MAX_SUGGESTIONS)
    .map((f) => ({ term: f.label, label: f.label, kind: 'Friend', count: searchFriends(f.label, left).length }))
}
