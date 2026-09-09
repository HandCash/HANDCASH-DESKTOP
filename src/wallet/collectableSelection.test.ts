import { describe, expect, it } from 'vitest'
import type { Collectable } from './collectables'
import {
  reconcileCollectableSelection,
  selectableCollectables,
  selectionState,
  toggleCollectableSelection,
} from './collectableSelection'

const item = (outpoint: string): Collectable =>
  ({ outpoint, origin: outpoint, name: outpoint } as Collectable)

describe('collectable selection', () => {
  const items = [item('a.0'), item('b.0'), item('c.0')]

  it('reports none, partial, and complete group selection', () => {
    expect(selectionState(new Set(), items)).toBe('none')
    expect(selectionState(new Set(['a.0']), items)).toBe('some')
    expect(selectionState(new Set(items.map((entry) => entry.outpoint)), items)).toBe('all')
  })

  it('selects and deselects a whole group without disturbing other items', () => {
    const selected = toggleCollectableSelection(new Set(['outside.0']), items, true)
    expect([...selected]).toEqual(['outside.0', 'a.0', 'b.0', 'c.0'])
    expect([...toggleCollectableSelection(selected, items.slice(0, 2), false)]).toEqual([
      'outside.0',
      'c.0',
    ])
  })

  it('drops missing and busy items during reconciliation', () => {
    const available = selectableCollectables(items, new Set(['b.0']))
    expect(available.map((entry) => entry.outpoint)).toEqual(['a.0', 'c.0'])
    expect([
      ...reconcileCollectableSelection(new Set(['a.0', 'b.0', 'gone.0']), available),
    ]).toEqual(['a.0'])
  })
})
