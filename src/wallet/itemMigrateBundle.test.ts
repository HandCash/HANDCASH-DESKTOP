import { describe, expect, it } from 'vitest'
import {
  MAX_ITEMS_PER_MIGRATE_TX,
  chooseItemMigrateUnit,
  splitItemMigrateBundle,
} from './itemMigrateBundle'

describe('chooseItemMigrateUnit', () => {
  it('refuses an empty page by name', () => {
    expect(chooseItemMigrateUnit([])).toEqual({ kind: 'refuse', reason: 'empty' })
  })

  it('sends a lone tip as a single', () => {
    expect(chooseItemMigrateUnit(['a'])).toEqual({ kind: 'single', item: 'a' })
  })

  it('bundles in page order up to the requested size', () => {
    const unit = chooseItemMigrateUnit(['a', 'b', 'c', 'd'], 3)
    expect(unit).toEqual({ kind: 'bundle', items: ['a', 'b', 'c'] })
  })

  it('never exceeds the per-transaction ceiling', () => {
    const items = Array.from({ length: 200 }, (_, i) => i)
    const unit = chooseItemMigrateUnit(items, 999)
    expect(unit.kind).toBe('bundle')
    if (unit.kind !== 'bundle') return
    expect(unit.items).toHaveLength(MAX_ITEMS_PER_MIGRATE_TX)
  })

  it('degrades to singles when asked for one per transaction', () => {
    expect(chooseItemMigrateUnit(['a', 'b'], 1)).toEqual({ kind: 'single', item: 'a' })
  })
})

describe('splitItemMigrateBundle', () => {
  it('halves a rejected bundle, larger half first', () => {
    expect(splitItemMigrateBundle(['a', 'b', 'c'])).toEqual([['a', 'b'], ['c']])
  })

  it('bottoms out at a single tip', () => {
    expect(splitItemMigrateBundle(['a'])).toEqual([['a'], []])
  })

  it('reaches every tip after repeated splits', () => {
    let pending = [['a', 'b', 'c', 'd', 'e']]
    const singles: string[] = []
    let guard = 0
    while (pending.length > 0 && guard < 50) {
      guard += 1
      const next: string[][] = []
      for (const group of pending) {
        if (group.length === 1) {
          singles.push(group[0]!)
          continue
        }
        const [left, right] = splitItemMigrateBundle(group)
        next.push(left, right)
      }
      pending = next.filter((g) => g.length > 0)
    }
    expect(singles.sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})
