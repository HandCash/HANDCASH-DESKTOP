import { describe, expect, it } from 'vitest'
import { PrivateKey } from '@bsv/sdk'
import { bapIdentityFixture } from './issuerIdentity.fixture'
import { verifyIssuerIdentityPackage, issuerIdentityImageDataUrl } from './issuerIdentity'
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

  it('shelves NFTs and FTs whose signer speaks for a BAP identity under that BAP ID', () => {
    const f = bapIdentityFixture({ name: 'Example Studio' })
    const identity = verifyIssuerIdentityPackage(f.pkg)!
    const signer = f.signer.toPublicKey().toString()
    const nextKey = PrivateKey.fromRandom().toPublicKey().toString()
    const assets = [
      item({ outpoint: 'aa.0', issuer: signer, bapId: f.bapId, app: 'An app', collectionId: 'awards' }),
      item({ outpoint: 'cc.0', issuer: nextKey, bapId: f.bapId }),
    ]
    const tokens = [token({ tokenId: 'bb', sym: 'FT', issuer: signer, bapId: f.bapId, issuerHandle: 'unverified-handle' })]
    const seen: unknown[] = []
    const result = groupCollectables(assets, tokens, (asset) => {
      seen.push(asset)
      return asset.bapId === f.bapId ? { kind: 'verified', identity } : null
    })
    expect(seen).toContainEqual({ issuer: signer, bapId: f.bapId, origin: 'aa_0' })
    expect(seen).toContainEqual({ issuer: signer, bapId: f.bapId, origin: 'bb' })
    expect(result.issuers).toHaveLength(1)
    expect(result.issuers[0]).toMatchObject({
      key: `issuer:bap:${f.bapId}`,
      label: 'Example Studio',
      icon: issuerIdentityImageDataUrl(identity.image!),
      bapId: f.bapId,
      issuerAttested: true,
    })
    expect(result.issuers[0]?.items).toHaveLength(2)
    expect(result.issuers[0]?.tokens).toHaveLength(1)
    expect(result.issuers[0]?.collections[0]?.quantity).toBe(1)
  })

  it('never shows an identity for an unattested asset or one the resolver refuses', () => {
    const f = bapIdentityFixture({ name: 'Example Studio' })
    const identity = verifyIssuerIdentityPackage(f.pkg)!
    const signer = f.signer.toPublicKey().toString()
    const assets = [item({ outpoint: 'aa.0', issuer: signer, bapId: f.bapId })]
    const refused = groupCollectables(assets, [], () => null)
    expect(refused.issuers[0]).toMatchObject({ key: `issuer:pubkey:${signer}` })
    expect(refused.issuers[0]?.icon).toBeUndefined()
    const unattested = groupCollectables(
      assets.map((asset) => ({ ...asset, issuerAttested: false })),
      [],
      () => ({ kind: 'verified', identity }),
    )
    expect(unattested.issuers[0]?.key).toBe(`issuer:claim:${signer}`)
    expect(unattested.issuers[0]?.label).not.toBe('Example Studio')
    const otherId = bapIdentityFixture({}).bapId
    const mismatched = groupCollectables(
      [item({ outpoint: 'aa.0', issuer: signer, bapId: otherId })],
      [],
      () => ({ kind: 'verified', identity }),
    )
    expect(mismatched.issuers[0]?.key).toBe(`issuer:pubkey:${signer}`)
    const retired = groupCollectables(assets, [], () => ({
      kind: 'refused',
      bapId: f.bapId,
      reason: 'retired-key',
    }))
    expect(retired.issuers[0]).toMatchObject({ key: `issuer:pubkey:${signer}` })
    expect(retired.issuers[0]?.bapId).toBeUndefined()
  })

  it('groups unconfirmed stamps by BAP ID across signers, with no name or image', () => {
    const f = bapIdentityFixture({ name: 'Example Studio' })
    const identity = verifyIssuerIdentityPackage(f.pkg)!
    const signer = f.signer.toPublicKey().toString()
    const stranger = PrivateKey.fromRandom().toPublicKey().toString()
    const result = groupCollectables(
      [
        item({ outpoint: 'aa.0', issuer: signer, bapId: f.bapId }),
        item({ outpoint: 'bb.0', issuer: stranger, bapId: f.bapId }),
        item({ outpoint: 'dd.0', issuer: PrivateKey.fromRandom().toPublicKey().toString(), bapId: f.bapId }),
      ],
      [token({ tokenId: 'cc', sym: 'FT', issuer: stranger, bapId: f.bapId, issuerHandle: '$studio' })],
      (asset) =>
        asset.issuer === signer
          ? { kind: 'verified', identity }
          : { kind: 'unconfirmed', bapId: f.bapId, reason: 'unknown-key' },
    )
    expect(result.issuers.map((i) => i.key).sort()).toEqual(
      [`issuer:bap-unconfirmed:${f.bapId}`, `issuer:bap:${f.bapId}`].sort(),
    )
    const unconfirmed = result.issuers.find((i) => i.bapState === 'unconfirmed')!
    expect(unconfirmed).toMatchObject({ bapId: f.bapId, issuerAttested: true })
    expect(unconfirmed.label).toMatch(/^Unconfirmed BAP /)
    expect(unconfirmed.label).not.toContain('Example Studio')
    expect(unconfirmed.label).not.toContain('$studio')
    expect(unconfirmed.icon).toBeUndefined()
    expect(unconfirmed.items.map((i) => i.outpoint)).toEqual(['bb.0', 'dd.0'])
    expect(unconfirmed.tokens).toHaveLength(1)
    expect(result.issuers.find((i) => i.bapState === 'verified')?.label).toBe('Example Studio')
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
