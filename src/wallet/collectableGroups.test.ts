import { describe, expect, it } from 'vitest'
import { PrivateKey } from '@bsv/sdk'
import { signPublicIdentityProfile } from './publicIdentityProfile'
import {
  collectionSeriesLabel,
  groupCollectables,
  groupQuantityLabel,
} from './collectableGroups'
import type { Collectable } from './collectables'
import type { FungibleToken } from './token/types'

function item(
  partial: Partial<Collectable> & Pick<Collectable, 'outpoint'>,
): Collectable {
  return {
    origin: partial.outpoint.replace('.', '_'),
    name: partial.outpoint.slice(0, 6),
    imageUrl: `https://content.test/${partial.outpoint}`,
    satoshis: 1,
    traits: [],
    extras: [],
    proven: false,
    authenticity: 'unproven',
    issuerAttested: true,
    ...partial,
  }
}

function token(
  partial: Partial<FungibleToken> & Pick<FungibleToken, 'tokenId' | 'sym'>,
): FungibleToken {
  return {
    amt: '100',
    dec: 0,
    utxoCount: 1,
    outpoint: `${partial.tokenId}.0`,
    spendKind: 'plain',
    issuerAttested: true,
    ...partial,
  }
}

describe('groupCollectables', () => {
  it('keeps an unsigned issuer claim away from an authenticated issuer shelf', () => {
    const issuer = PrivateKey.fromHex('01').toPublicKey().toString()
    const result = groupCollectables(
      [
        item({ outpoint: 'aa.0', issuer, issuerAttested: true }),
        item({ outpoint: 'cc.0', issuer, issuerAttested: false }),
      ],
      [token({ tokenId: 'bb', sym: 'FAKE', issuer, issuerAttested: false })],
    )
    expect(result.issuers.map((group) => group.key).sort()).toEqual([
      `issuer:claim:${issuer}`,
      `issuer:pubkey:${issuer}`,
    ])
    const claimed = result.issuers.find((group) => !group.issuerAttested)
    expect(claimed?.tokens).toHaveLength(1)
    expect(claimed?.label).toContain('Issuer claim')
    expect(claimed?.icon).toBeUndefined()
  })

  it('groups new NFTs and FTs by issuer key and displays only a matching signed profile', () => {
    const root = PrivateKey.fromHex('01')
    const issuer = root.toPublicKey().toString()
    const profile = signPublicIdentityProfile(root.toHex(), 'main', {
      displayName: 'Example Studio',
      icon: 'https://example.test/icon.png',
      description: 'Items and awards',
    })
    const assets = [
      item({
        outpoint: 'aa.0',
        issuer,
        issuerProfile: profile,
        app: 'An app',
        collectionId: 'awards',
      }),
    ]
    const tokens = [
      token({
        tokenId: 'bb',
        sym: 'FT',
        issuer,
        issuerHandle: 'unverified-handle',
      }),
    ]
    const result = groupCollectables(assets, tokens)
    expect(result.issuers).toHaveLength(1)
    expect(result.issuers[0]).toMatchObject({
      key: `issuer:pubkey:${issuer}`,
      identityKey: issuer,
      label: profile.displayName,
      icon: profile.icon,
    })
    expect(result.issuers[0]?.tokens).toHaveLength(1)
    expect(result.issuers[0]?.collections[0]?.quantity).toBe(1)
    const tampered = groupCollectables(
      [
        {
          ...assets[0]!,
          issuerProfile: { ...profile, displayName: 'Imposter' },
        },
      ],
      tokens,
    )
    expect(tampered.issuers[0]?.icon).toBeUndefined()
    expect(tampered.issuers[0]?.label).not.toBe('Imposter')
    const wrongKey = signPublicIdentityProfile(
      PrivateKey.fromHex('02').toHex(),
      'main',
      { displayName: 'Wrong issuer', icon: profile.icon, description: '' },
    )
    expect(
      groupCollectables(
        assets.map((asset) => ({ ...asset, issuerProfile: wrongKey })),
        tokens,
      ).issuers[0]?.label,
    ).not.toBe('Wrong issuer')
  })
  it('nests collections under the issuer, not the other way around', () => {
    const { issuers, singles, ungrouped } = groupCollectables([
      item({
        outpoint: 'aa.0',
        collectionId: 'foxes',
        app: 'Bubblemint',
        name: 'Pixel Foxes #1',
      }),
      item({
        outpoint: 'bb.0',
        collectionId: 'foxes',
        app: 'Bubblemint',
        name: 'Pixel Foxes #2',
      }),
      item({
        outpoint: 'cc.0',
        collectionId: 'solo-set',
        app: 'Bubblemint',
        name: 'Pixel Foxes #9',
      }),
      item({ outpoint: 'dd.0' }),
    ])

    expect(issuers).toHaveLength(1)
    expect(issuers[0]?.label).toBe('Bubblemint')
    expect(issuers[0]?.collections).toHaveLength(2)
    expect(issuers[0]?.collections.map((g) => g.quantity).sort()).toEqual([
      1, 2,
    ])
    expect(issuers[0]?.collections.every((g) => g.app === 'Bubblemint')).toBe(
      true,
    )
    expect(singles).toHaveLength(0)
    expect(ungrouped.map((i) => i.outpoint)).toEqual(['dd.0'])
  })

  it('keeps a one-item collection under its issuer', () => {
    const { issuers, singles } = groupCollectables([
      item({
        outpoint: 'aa.0',
        collectionId: 'solo',
        app: 'Zoo',
        name: 'Bear #1',
      }),
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
    expect(issuers[0]?.key).toBe('issuer:app:bitcoin bear')
    expect(issuers[0]?.loose).toHaveLength(2)
    expect(issuers[0]?.collections).toHaveLength(0)
  })

  it('does not collapse two collections from one issuer into one shelf', () => {
    const { issuers } = groupCollectables([
      item({
        outpoint: 'aa.0',
        collectionId: 'foxes',
        app: 'Zoo',
        name: 'Fox #1',
      }),
      item({
        outpoint: 'bb.0',
        collectionId: 'foxes',
        app: 'Zoo',
        name: 'Fox #2',
      }),
      item({
        outpoint: 'cc.0',
        collectionId: 'bears',
        app: 'Zoo',
        name: 'Bear #1',
      }),
      item({
        outpoint: 'dd.0',
        collectionId: 'bears',
        app: 'Zoo',
        name: 'Bear #2',
      }),
    ])
    expect(issuers).toHaveLength(1)
    expect(issuers[0]?.collections.map((g) => g.label).sort()).toEqual([
      'Bear',
      'Fox',
    ])
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
  it('keeps label-only collectables separate from a keyed token with the same handle', () => {
    const issuer = '02' + 'ab'.repeat(32)
    const { issuers } = groupCollectables(
      [item({ outpoint: 'aa.0', collectionId: 'foxes', app: '$mint' })],
      [token({ tokenId: 't1', sym: 'FOX', issuerHandle: '$mint', issuer })],
    )
    expect(issuers).toHaveLength(2)
    const keyed = issuers.find((row) => row.identityKey === issuer)!
    expect(keyed.tokens.map((t) => t.sym)).toEqual(['FOX'])
    expect(keyed.items).toHaveLength(0)
  })

  it('cannot join a keyed shelf through a crafted app label', () => {
    const issuer = '02' + 'ab'.repeat(32)
    const { issuers } = groupCollectables(
      [item({ outpoint: 'aa.0', app: `pubkey:${issuer}` })],
      [token({ tokenId: 't1', sym: 'A', issuer })],
    )
    expect(issuers).toHaveLength(2)
    expect(
      issuers.find((row) => row.identityKey === issuer)?.items,
    ).toHaveLength(0)
  })

  it('groups the same key despite different handles, key casing and whitespace', () => {
    const issuer = '02' + 'ab'.repeat(32)
    const { issuers } = groupCollectables(
      [],
      [
        token({ tokenId: 't1', sym: 'A', issuer, issuerHandle: '$old' }),
        token({
          tokenId: 't2',
          sym: 'B',
          issuer: '  ' + issuer.toUpperCase() + '  ',
          issuerHandle: '$new',
        }),
        token({ tokenId: 't3', sym: 'C', issuer }),
      ],
    )
    expect(issuers).toHaveLength(1)
    expect(issuers[0]?.key).toBe(`issuer:pubkey:${issuer}`)
    expect(issuers[0]?.identityKey).toBe(issuer)
    expect(issuers[0]?.tokens).toHaveLength(3)
    expect(issuers[0]?.label).not.toContain('$')
  })

  it('separates different issuer keys even when they share a display handle', () => {
    const { issuers } = groupCollectables(
      [],
      [
        token({
          tokenId: 't1',
          sym: 'A',
          issuer: '02' + 'ab'.repeat(32),
          issuerHandle: '$same',
        }),
        token({
          tokenId: 't2',
          sym: 'B',
          issuer: '03' + 'cd'.repeat(32),
          issuerHandle: '$same',
        }),
      ],
    )
    expect(issuers).toHaveLength(2)
    expect(issuers.every((row) => row.tokens.length === 1)).toBe(true)
  })

  it('keeps missing and malformed keys unknown despite an issuer handle', () => {
    const { issuers, ungroupedTokens } = groupCollectables(
      [],
      [
        token({ tokenId: 't1', sym: 'A', issuerHandle: '$known' }),
        token({
          tokenId: 't2',
          sym: 'B',
          issuer: '02ab',
          issuerHandle: '$known',
        }),
      ],
    )
    expect(issuers).toHaveLength(0)
    expect(ungroupedTokens).toHaveLength(2)
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

  it('keeps token facepiles and quantities under their key', () => {
    const { issuers } = groupCollectables(
      [],
      [
        token({
          tokenId: 't1',
          sym: 'A',
          issuer: '02' + 'ab'.repeat(32),
          iconUrl: 'data:image/png;base64,a',
        }),
        token({ tokenId: 't2', sym: 'B', issuer: '02' + 'ab'.repeat(32) }),
      ],
    )
    expect(issuers[0]?.faces.map((f) => f.name)).toEqual(['A'])
    expect(issuers[0]?.overflow).toBe(1)
    expect(groupQuantityLabel(issuers[0]!)).toBe('2 tokens')
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
