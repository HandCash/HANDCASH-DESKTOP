import { describe, expect, it } from 'vitest'
import { groupCollectables, groupQuantityLabel } from './collectableGroups'
import type { Collectable } from './collectables'

function item(partial: Partial<Collectable> & Pick<Collectable, 'outpoint'>): Collectable {
  return {
    origin: partial.outpoint.replace('.', '_'),
    name: partial.outpoint.slice(0, 6),
    imageUrl: `https://content.test/${partial.outpoint}`,
    satoshis: 1,
    traits: [],
    extras: [],
    proven: false,
    authenticity: 'unproven',
    ...partial,
  }
}

describe('groupCollectables', () => {
  it('folds collections and leaves items with no axis loose', () => {
    const { groups, loose } = groupCollectables([
      item({ outpoint: 'aa.0', collectionId: 'foxes', app: 'Zoo' }),
      item({ outpoint: 'bb.0', collectionId: 'foxes', app: 'Zoo' }),
      item({ outpoint: 'cc.0' }),
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0]?.label).toBe('Zoo')
    expect(groups[0]?.quantity).toBe(2)
    expect(groups[0]?.faces.map((f) => f.outpoint)).toEqual(['aa.0', 'bb.0'])
    expect(groups[0]?.overflow).toBe(0)
    expect(loose.map((i) => i.outpoint)).toEqual(['cc.0'])
  })

  it('does not fold a collection of one', () => {
    const { groups, loose } = groupCollectables([
      item({ outpoint: 'aa.0', collectionId: 'solo', app: 'Zoo' }),
    ])
    expect(groups).toHaveLength(0)
    expect(loose.map((i) => i.outpoint)).toEqual(['aa.0'])
  })

  it('groups by app when the mint carried no collection', () => {
    const { groups } = groupCollectables([
      item({ outpoint: 'aa.0', app: 'Bitcoin Bear' }),
      item({ outpoint: 'bb.0', app: 'Bitcoin Bear' }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.key).toBe('app:bitcoin bear')
    expect(groups[0]?.label).toBe('Bitcoin Bear')
  })

  it('disambiguates two collections from one app', () => {
    const { groups } = groupCollectables([
      item({ outpoint: 'aa.0', collectionId: 'collection-foxes-01', app: 'Zoo' }),
      item({ outpoint: 'bb.0', collectionId: 'collection-foxes-01', app: 'Zoo' }),
      item({ outpoint: 'cc.0', collectionId: 'collection-bears-02', app: 'Zoo' }),
      item({ outpoint: 'dd.0', collectionId: 'collection-bears-02', app: 'Zoo' }),
    ])
    expect(groups.map((g) => g.label)).toEqual([
      'Zoo · collec…s-01',
      'Zoo · collec…s-02',
    ])
  })

  it('caps the facepile and reports the overflow', () => {
    const { groups } = groupCollectables(
      Array.from({ length: 7 }, (_, i) =>
        item({ outpoint: `${i}${i}.0`, collectionId: 'many', app: 'Set' }),
      ),
    )
    expect(groups[0]?.faces).toHaveLength(4)
    expect(groups[0]?.overflow).toBe(3)
    expect(groups[0]?.quantity).toBe(7)
  })

  it('skips duplicate art in the facepile', () => {
    const { groups } = groupCollectables([
      item({ outpoint: 'aa.0', collectionId: 'kit', app: 'Kat', imageUrl: 'https://c/one' }),
      item({ outpoint: 'bb.0', collectionId: 'kit', app: 'Kat', imageUrl: 'https://c/one' }),
      item({ outpoint: 'cc.0', collectionId: 'kit', app: 'Kat', imageUrl: 'https://c/two' }),
    ])
    expect(groups[0]?.faces.map((f) => f.imageUrl)).toEqual(['https://c/one', 'https://c/two'])
    expect(groups[0]?.overflow).toBe(1)
  })

  it('reports quantity and verified count', () => {
    const { groups } = groupCollectables([
      item({ outpoint: 'aa.0', collectionId: 'p', app: 'P', proven: true, authenticity: 'brc150' }),
      item({ outpoint: 'bb.0', collectionId: 'p', app: 'P' }),
    ])
    expect(groupQuantityLabel(groups[0]!)).toBe('2 items · 1 verified')
  })

  it('sorts groups alphabetically', () => {
    const { groups } = groupCollectables([
      item({ outpoint: 'aa.0', app: 'Zebra' }),
      item({ outpoint: 'bb.0', app: 'Zebra' }),
      item({ outpoint: 'cc.0', app: 'Antler' }),
      item({ outpoint: 'dd.0', app: 'Antler' }),
    ])
    expect(groups.map((g) => g.label)).toEqual(['Antler', 'Zebra'])
  })
})
