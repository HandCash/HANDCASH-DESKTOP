import { describe, expect, it } from 'vitest'
import { searchCollectables } from './collectableSearch'
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
