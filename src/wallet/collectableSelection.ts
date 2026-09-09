import type { Collectable } from './collectables'

export type SelectionState = 'none' | 'some' | 'all'

export function selectableCollectables(
  items: readonly Collectable[],
  busyOutpoints: ReadonlySet<string>,
): Collectable[] {
  return items.filter((item) => !busyOutpoints.has(item.outpoint))
}

export function reconcileCollectableSelection(
  selected: ReadonlySet<string>,
  items: readonly Collectable[],
): Set<string> {
  const held = new Set(items.map((item) => item.outpoint))
  return new Set([...selected].filter((outpoint) => held.has(outpoint)))
}

export function selectionState(
  selected: ReadonlySet<string>,
  items: readonly Collectable[],
): SelectionState {
  if (items.length === 0) return 'none'
  const count = items.reduce(
    (total, item) => total + (selected.has(item.outpoint) ? 1 : 0),
    0,
  )
  if (count === 0) return 'none'
  return count === items.length ? 'all' : 'some'
}

export function toggleCollectableSelection(
  selected: ReadonlySet<string>,
  items: readonly Collectable[],
  checked: boolean,
): Set<string> {
  const next = new Set(selected)
  for (const item of items) {
    if (checked) next.add(item.outpoint)
    else next.delete(item.outpoint)
  }
  return next
}
