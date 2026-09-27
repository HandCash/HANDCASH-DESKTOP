import { describe, expect, it } from 'vitest'
import {
  collectionSeriesLabel,
  groupCollectables,
  groupQuantityLabel,
} from './collectableGroups'
import type { Collectable } from './collectables'
import type { FungibleToken } from './token/types'

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

function token(partial: Partial<FungibleToken> & Pick<FungibleToken, 'tokenId' | 'sym'>): FungibleToken {
  return {
    amt: '100',
    dec: 0,
    utxoCount: 1,
    outpoint: `${partial.tokenId}.0`,
    spendKind: 'plain',
    ...partial,
  }
}

describe('groupCollectables', () => {
  it('nests collections under the issuer, not the other way around', () => {
    const { issuers, singles, ungrouped } = groupCollectables([
      item({ outpoint: 'aa.0', collectionId: 'foxes', app: 'Bubblemint', name: 'Pixel Foxes #1' }),
      item({ outpoint: 'bb.0', collectionId: 'foxes', app: 'Bubblemint', name: 'Pixel Foxes #2' }),
      item({ outpoint: 'cc.0', collectionId: 'solo-set', app: 'Bubblemint', name: 'Pixel Foxes #9' }),
      item({ outpoint: 'dd.0' }),
    ])

    expect(issuers).toHaveLength(1)
    expect(issuers[0]?.label).toBe('Bubblemint')
    expect(issuers[0]?.collections).toHaveLength(2)
    expect(issuers[0]?.collections.map((g) => g.quantity).sort()).toEqual([1, 2])
    expect(issuers[0]?.collections.every((g) => g.app === 'Bubblemint')).toBe(true)
    expect(singles).toHaveLength(0)
    expect(ungrouped.map((i) => i.outpoint)).toEqual(['dd.0'])
  })

  it('keeps a one-item collection under its issuer', () => {
    const { issuers, singles } = groupCollectables([
      item({ outpoint: 'aa.0', collectionId: 'solo', app: 'Zoo', name: 'Bear #1' }),
    ])
    expect(issuers).toHaveLength(1)
    expect(issuers[0]?.collections).toHaveLength(1)
    expect(issuers[0]?.collections[0]?.quantity).toBe(1)
    expect(singles).toHaveLength(0)
  })

  it('groups by issuer when the mint carried no collection', () => {
    const { issuers } = groupCollectables([
      item({ outpoint: 'aa.0', app: 'Bitcoin Bear' }),
      item({ outpoint: 'bb.0', app: 'Bitcoin Bear' }),
    ])
    expect(issuers).toHaveLength(1)
    expect(issuers[0]?.key).toBe('issuer:bitcoin bear')
    expect(issuers[0]?.loose).toHaveLength(2)
    expect(issuers[0]?.collections).toHaveLength(0)
  })

  it('does not collapse two collections from one issuer into one shelf', () => {
    const { issuers } = groupCollectables([
      item({ outpoint: 'aa.0', collectionId: 'foxes', app: 'Zoo', name: 'Fox #1' }),
      item({ outpoint: 'bb.0', collectionId: 'foxes', app: 'Zoo', name: 'Fox #2' }),
      item({ outpoint: 'cc.0', collectionId: 'bears', app: 'Zoo', name: 'Bear #1' }),
      item({ outpoint: 'dd.0', collectionId: 'bears', app: 'Zoo', name: 'Bear #2' }),
    ])
    expect(issuers).toHaveLength(1)
    expect(issuers[0]?.collections.map((g) => g.label).sort()).toEqual(['Bear', 'Fox'])
  })

  it('caps the facepile and reports the overflow', () => {
    const { issuers } = groupCollectables(
      Array.from({ length: 7 }, (_, i) =>
        item({ outpoint: `${i}${i}.0`, collectionId: 'many', app: 'Set' }),
      ),
    )
    expect(issuers[0]?.faces).toHaveLength(4)
    expect(issuers[0]?.overflow).toBe(3)
    expect(issuers[0]?.quantity).toBe(7)
  })

  it('reports quantity and verified count', () => {
    const { issuers } = groupCollectables([
      item({
        outpoint: 'aa.0',
        collectionId: 'p',
        app: 'P',
        proven: true,
        authenticity: 'brc150',
      }),
      item({ outpoint: 'bb.0', collectionId: 'p', app: 'P' }),
    ])
    expect(groupQuantityLabel(issuers[0]!)).toBe('2 items · 1 verified')
  })

  it('sorts issuers alphabetically', () => {
    const { issuers } = groupCollectables([
      item({ outpoint: 'aa.0', app: 'Zebra' }),
      item({ outpoint: 'bb.0', app: 'Zebra' }),
      item({ outpoint: 'cc.0', app: 'Antler' }),
      item({ outpoint: 'dd.0', app: 'Antler' }),
    ])
    expect(issuers.map((g) => g.label)).toEqual(['Antler', 'Zebra'])
  })
})

describe('groupCollectables with fungibles', () => {
  it('shelves a token under the issuer whose handle minted the items', () => {
    const { issuers, ungroupedTokens } = groupCollectables(
      [
        item({ outpoint: 'aa.0', collectionId: 'foxes', app: '$mint', name: 'Fox #1' }),
        item({ outpoint: 'bb.0', app: '$mint', name: 'Loose' }),
      ],
      [token({ tokenId: 't1', sym: 'FOX', issuerHandle: '$Mint', issuer: '02ab' })],
    )
    expect(issuers).toHaveLength(1)
    expect(issuers[0]?.key).toBe('issuer:$mint')
    expect(issuers[0]?.tokens.map((t) => t.sym)).toEqual(['FOX'])
    expect(issuers[0]?.items).toHaveLength(2)
    expect(issuers[0]?.quantity).toBe(2)
    expect(ungroupedTokens).toHaveLength(0)
  })

  it('gives a tokens-only issuer its own folder, keyed by handle or pubkey', () => {
    const pubkey = '02' + 'ab'.repeat(32)
    const { issuers } = groupCollectables(
      [],
      [
        token({ tokenId: 't1', sym: 'ZED', issuerHandle: '$zed' }),
        token({ tokenId: 't2', sym: 'ANON', issuer: pubkey }),
        token({ tokenId: 't3', sym: 'ANON2', issuer: pubkey.toUpperCase() }),
      ],
    )
    // Sorted by label: '$zed' sorts before the shortened pubkey.
    expect(issuers.map((i) => i.key)).toEqual(['issuer:$zed', `issuer:pubkey:${pubkey}`])
    const anon = issuers[1]!
    expect(anon.tokens.map((t) => t.sym)).toEqual(['ANON', 'ANON2'])
    expect(anon.items).toHaveLength(0)
    expect(anon.quantity).toBe(0)
    expect(groupQuantityLabel(anon)).toBe('2 tokens')
    expect(groupQuantityLabel(issuers[0]!)).toBe('1 token')
  })

  it('keeps tokens with no issuer on the top shelf', () => {
    const { issuers, ungroupedTokens } = groupCollectables(
      [item({ outpoint: 'aa.0', app: 'Zoo' })],
      [token({ tokenId: 't1', sym: 'FREE' })],
    )
    expect(issuers).toHaveLength(1)
    expect(issuers[0]?.tokens).toHaveLength(0)
    expect(ungroupedTokens.map((t) => t.sym)).toEqual(['FREE'])
  })

  it('fills the facepile with token icons after item art, and counts both in the meta', () => {
    const { issuers } = groupCollectables(
      [item({ outpoint: 'aa.0', app: 'Zoo', proven: true, authenticity: 'brc150' })],
      [
        token({ tokenId: 't1', sym: 'A', issuerHandle: 'Zoo', iconUrl: 'data:image/png;base64,a' }),
        token({ tokenId: 't2', sym: 'B', issuerHandle: 'Zoo' }),
      ],
    )
    expect(issuers[0]?.faces.map((f) => f.name)).toEqual(['aa.0', 'A'])
    expect(issuers[0]?.overflow).toBe(1)
    expect(groupQuantityLabel(issuers[0]!)).toBe('2 tokens · 1 item · 1 verified')
  })
})

describe('collectionSeriesLabel', () => {
  it('strips the token number so a set reads as one name', () => {
    expect(
      collectionSeriesLabel([
        item({ outpoint: 'a.0', name: 'Pixel Foxes #1' }),
        item({ outpoint: 'b.0', name: 'Pixel Foxes #9999' }),
      ]),
    ).toBe('Pixel Foxes')
  })
})
