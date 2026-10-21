import { describe, expect, it } from 'vitest'
import { searchCollectables, suggestCollectableTerms } from './collectableSearch'
import type { Collectable } from './collectables'

function tip(over: Partial<Collectable> = {}): Collectable {
  return {
    outpoint: `${'aa'.repeat(32)}.0`,
    origin: `${'bb'.repeat(32)}_0`,
    name: 'Pixel Foxes #9999968',
    imageUrl: '',
    satoshis: 1,
    traits: [{ name: 'Background', value: 'Forest' }],
    extras: [],
    proven: true,
    authenticity: 'brc150',
    collectionId: 'pixel-foxes',
    app: 'Market',
    ...over,
  }
}

describe('searchCollectables', () => {
  const items = [
    tip(),
    tip({
      outpoint: `${'cc'.repeat(32)}.1`,
      name: 'Pixel Foxes #9999871',
      traits: [{ name: 'Background', value: 'Desert' }],
    }),
    tip({
      outpoint: `${'dd'.repeat(32)}.0`,
      name: 'Kit Kat',
      origin: `${'ee'.repeat(32)}_3`,
      traits: [],
      collectionId: 'kit-kat',
      app: undefined,
    }),
  ]

  it('returns all items for empty query', () => {
    expect(searchCollectables('', items)).toHaveLength(3)
    expect(searchCollectables('  ', items)).toHaveLength(3)
  })

  it('matches name, collection, app, origin, and traits', () => {
    expect(searchCollectables('kit kat', items).map((i) => i.name)).toEqual(['Kit Kat'])
    expect(searchCollectables('pixel-foxes', items)).toHaveLength(2)
    expect(searchCollectables('market', items)).toHaveLength(2)
    expect(searchCollectables('forest', items).map((i) => i.name)).toEqual([
      'Pixel Foxes #9999968',
    ])
    expect(searchCollectables('9999871', items)).toHaveLength(1)
  })

  it('applies comma-separated terms as AND filters', () => {
    expect(searchCollectables('pixel, desert', items).map((i) => i.name)).toEqual([
      'Pixel Foxes #9999871',
    ])
    expect(searchCollectables('pixel, ocean', items)).toHaveLength(0)
  })
})

describe('searchCollectables index', () => {
  it('answers repeat searches the same and indexes a replaced item afresh', () => {
    const fox = tip({ outpoint: 'a.0', traits: [{ name: 'Background', value: 'Forest' }] })
    const items = [fox, tip({ outpoint: 'b.0', traits: [{ name: 'Background', value: 'Desert' }] })]
    expect(searchCollectables('forest', items)).toEqual([fox])
    expect(searchCollectables('forest', items)).toEqual([fox])

    const renamed = { ...fox, traits: [{ name: 'Background', value: 'Ocean' }] }
    const next = [renamed, items[1]]
    expect(searchCollectables('forest', next)).toEqual([])
    expect(searchCollectables('ocean', next)).toEqual([renamed])
  })
})

describe('suggestCollectableTerms', () => {
  const items = [
    tip({ outpoint: 'a.0', name: 'Pixel Foxes #1', traits: [{ name: 'Background', value: 'Forest' }] }),
    tip({ outpoint: 'b.0', name: 'Pixel Foxes #2', traits: [{ name: 'Background', value: 'Forest' }] }),
    tip({ outpoint: 'c.0', name: 'Pixel Foxes #3', traits: [{ name: 'Background', value: 'Desert' }] }),
  ]

  it('completes a typed prefix with counted trait values, commonest first', () => {
    const out = suggestCollectableTerms('f', [], items)
    expect(out[0]).toEqual({ term: 'Background Forest', label: 'Forest', kind: 'Background', count: 2 })
  })

  it('offers the shared name without its number', () => {
    const out = suggestCollectableTerms('pix', [], items)
    expect(out[0]).toMatchObject({ term: 'Pixel Foxes', kind: 'Name', count: 3 })
  })

  it('counts against the applied terms and leaves them out', () => {
    const out = suggestCollectableTerms('', ['Background Forest'], items)
    expect(out.map((s) => s.term)).not.toContain('Background Forest')
    expect(out.every((s) => s.count <= 2)).toBe(true)
    expect(searchCollectables('Background Forest', items)).toHaveLength(2)
  })

  it('with nothing typed, only offers terms that narrow the list', () => {
    const out = suggestCollectableTerms('', [], items)
    expect(out.map((s) => s.label)).toEqual(['Forest', 'Desert'])
  })
})
