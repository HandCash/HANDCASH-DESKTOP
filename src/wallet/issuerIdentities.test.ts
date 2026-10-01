import { PrivateKey, Script, Utils, type ChainTracker } from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ values: new Map<string, string>(), writable: true }))
vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => state.values.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    if (!state.writable) return false
    state.values.set(key, value)
    return true
  },
  durableRemoveItem: (key: string) => {
    state.values.delete(key)
  },
}))

import { bapAliasScript, bapIdScript } from './bapRecords'
import { bapIdentityFixture, beefOf, recordTx, rotationTx } from './issuerIdentity.fixture'
import {
  issuerAttribution,
  issuerIdentityFor,
  issuerIdentityForSigner,
  issuerIdentityPackage,
  rememberConfirmedIssuerIdentityPackage,
  rememberIssuerIdentityPackage,
  resetIssuerIdentitiesForTests,
} from './issuerIdentities'
import {
  buildIssuerIdentityPackage,
  IDENTITY_IMAGE_MAX_BYTES,
  issuerIdentityImage,
  issuerIdentityPackageBeef,
  issuerProfile,
} from './issuerIdentity'
import { MAX_ENVELOPE_IDENTITIES, rememberDeliveredIdentities } from './issuerIdentityDelivery'
import { appendIssuerMetadata, issuerMetadataFromScript } from './issuerMetadata'

const pub = (key: PrivateKey) => key.toPublicKey().toString()
const tracker = (valid: boolean): ChainTracker => ({
  isValidRootForHeight: vi.fn(async () => valid),
  currentHeight: async () => 1_000_000,
})

beforeEach(() => {
  state.values.clear()
  state.writable = true
  resetIssuerIdentitiesForTests()
})

describe('item reference', () => {
  it('writes and reads the BAP ID; legacy self-asserted profiles are ignored', () => {
    const lock = '76a914' + '00'.repeat(20) + '88ac'
    const issuer = pub(PrivateKey.fromRandom())
    const { bapId } = bapIdentityFixture({})
    expect(issuerMetadataFromScript(appendIssuerMetadata(lock, issuer, bapId))).toEqual({ issuer, bapId })
    expect(() => appendIssuerMetadata(lock, issuer, 'not-a-bap-id')).toThrow(/BAP ID/)
    const legacy = new Script()
    legacy.writeOpCode(0x6a)
    for (const field of ['1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5', 'SET', 'issuer', issuer, 'issuerProfile', '{"displayName":"x"}'])
      legacy.writeBin(Utils.toArray(field, 'utf8'))
    expect(issuerMetadataFromScript(lock + legacy.toHex())).toEqual({ issuer })
  })

  it('refuses URL images, oversized images and unsupported types', () => {
    expect(() =>
      issuerIdentityImage({ contentType: 'text/uri-list', bytes: Uint8Array.from(Utils.toArray('https://x.test/a.png', 'utf8')) }),
    ).toThrow(/WebP, PNG or JPEG/)
    expect(() => issuerIdentityImage({ contentType: 'image/webp', bytes: new Uint8Array(IDENTITY_IMAGE_MAX_BYTES + 1) })).toThrow(
      /64 KB/,
    )
  })
})

describe('store once', () => {
  it('keeps one package per BAP ID and serves every asset that names it', () => {
    const f = bapIdentityFixture({ name: 'Studio' })
    expect(rememberIssuerIdentityPackage('main', f.pkg)?.bapId).toBe(f.bapId)
    const keys = [...state.values.keys()]
    expect(rememberIssuerIdentityPackage('main', f.pkg)?.bapId).toBe(f.bapId)
    expect([...state.values.keys()]).toEqual(keys)
    expect(issuerIdentityPackage('main', f.bapId)).toEqual(f.pkg)
    resetIssuerIdentitiesForTests()
    expect(issuerIdentityFor('main', f.bapId)?.name).toBe('Studio')
    expect(issuerIdentityFor('test', f.bapId)).toBeNull()
  })

  it('merges a peer rotation into the stored chain', () => {
    const f = bapIdentityFixture({ aliasHeight: 900_010 })
    rememberIssuerIdentityPackage('main', f.pkg)
    const { tx, next } = rotationTx(f, 1, { name: 'Studio II', minedHeight: 900_020 })
    const rotated = buildIssuerIdentityPackage(f.bapId, [issuerIdentityPackageBeef(f.pkg), beefOf(tx)])!
    const identity = rememberIssuerIdentityPackage('main', rotated)!
    expect(identity.keys.map((k) => k.address)).toEqual([f.signer.toAddress(), next.toAddress()])
    expect(issuerIdentityForSigner('main', { bapId: f.bapId, signer: pub(f.signer), minedHeight: 900_015 })?.name).toBe(
      'Studio II',
    )
    expect(issuerIdentityForSigner('main', { bapId: f.bapId, signer: pub(f.signer), minedHeight: 900_030 })).toBeNull()
    expect(issuerIdentityForSigner('main', { bapId: f.bapId, signer: pub(next) })?.bapId).toBe(f.bapId)
  })

  it('tells an unconfirmed stamp apart from one the package refuses', () => {
    const f = bapIdentityFixture({ aliasHeight: 900_010 })
    const stranger = pub(PrivateKey.fromRandom())
    expect(issuerAttribution('main', { bapId: f.bapId, signer: pub(f.signer), minedHeight: 900_015 })).toEqual({
      kind: 'unconfirmed',
      bapId: f.bapId,
      reason: 'no-package',
    })
    expect(issuerAttribution('main', { bapId: 'not-a-bap-id', signer: stranger })).toBeNull()
    const { tx } = rotationTx(f, 1, { name: 'Studio II', minedHeight: 900_020 })
    rememberIssuerIdentityPackage('main', buildIssuerIdentityPackage(f.bapId, [issuerIdentityPackageBeef(f.pkg), beefOf(tx)])!)
    const old = (minedHeight?: number) => issuerAttribution('main', { bapId: f.bapId, signer: pub(f.signer), minedHeight })
    expect(old(900_015)).toMatchObject({ kind: 'verified', identity: { name: 'Studio II' } })
    expect(old(900_030)).toEqual({ kind: 'refused', bapId: f.bapId, reason: 'retired-key' })
    expect(old()).toEqual({ kind: 'unconfirmed', bapId: f.bapId, reason: 'height-unknown' })
    expect(issuerAttribution('main', { bapId: f.bapId, signer: stranger, minedHeight: 900_015 })).toEqual({
      kind: 'unconfirmed',
      bapId: f.bapId,
      reason: 'unknown-key',
    })
  })

  it('a leaked retired key cannot fork a chain the store already holds', () => {
    const f = bapIdentityFixture({ aliasHeight: 900_010 })
    const honest = rotationTx(f, 1, { minedHeight: 900_020 })
    rememberIssuerIdentityPackage(
      'main',
      buildIssuerIdentityPackage(f.bapId, [issuerIdentityPackageBeef(f.pkg), beefOf(honest.tx)])!,
    )
    const thief = PrivateKey.fromRandom()
    const fork = recordTx(
      [
        bapIdScript({ bapId: f.bapId, address: thief.toAddress(), signer: f.signer }),
        bapAliasScript({ bapId: f.bapId, profile: issuerProfile({ name: 'Thief', description: '' }, f.imageTx.id('hex')), signer: thief }),
      ],
      900_030,
    )
    const forged = buildIssuerIdentityPackage(f.bapId, [issuerIdentityPackageBeef(f.pkg), beefOf(fork)])!
    expect(rememberIssuerIdentityPackage('main', forged)?.keys.at(-1)!.address).toBe(honest.next.toAddress())
    expect(issuerIdentityFor('main', f.bapId)?.name).toBe('Studio')
  })

  it('only own flows rewrite a pinned identity', () => {
    const f = bapIdentityFixture({ aliasHeight: 900_010 })
    rememberIssuerIdentityPackage('main', f.pkg, { pin: true })
    const update = recordTx(
      [bapAliasScript({ bapId: f.bapId, profile: issuerProfile({ name: 'Peer copy', description: '' }, f.imageTx.id('hex')), signer: f.signer })],
      900_020,
    )
    const peer = buildIssuerIdentityPackage(f.bapId, [issuerIdentityPackageBeef(f.pkg), beefOf(update)])!
    expect(rememberIssuerIdentityPackage('main', peer)?.name).toBe('Studio')
    expect(rememberIssuerIdentityPackage('main', peer, { pin: true, replace: true })?.name).toBe('Peer copy')
  })

  it('evicts unpinned peers first and never a pinned own identity', () => {
    const own = bapIdentityFixture({ name: 'Mine' })
    rememberIssuerIdentityPackage('main', own.pkg, { pin: true })
    for (let i = 0; i < 12; i++) rememberIssuerIdentityPackage('main', bapIdentityFixture({ name: `Peer ${i}` }).pkg)
    expect(issuerIdentityFor('main', own.bapId)?.name).toBe('Mine')
    const entries = [...state.values.keys()].filter((key) => /:main:[1-9A-HJ-NP-Za-km-z]+$/.test(key))
    expect(entries.length).toBe(9)
  })

  it('refuses packages it cannot persist', () => {
    state.writable = false
    expect(rememberIssuerIdentityPackage('main', bapIdentityFixture({}).pkg)).toBeNull()
  })
})

describe('peer packages', () => {
  it('keeps a proven package only when every root matches a block header', async () => {
    const f = bapIdentityFixture({ imageHeight: 900_005, aliasHeight: 900_010 })
    expect(await rememberConfirmedIssuerIdentityPackage('main', f.pkg, tracker(false))).toBeNull()
    expect(await rememberConfirmedIssuerIdentityPackage('main', f.pkg, null)).toBeNull()
    const ok = tracker(true)
    expect((await rememberConfirmedIssuerIdentityPackage('main', f.pkg, ok))?.bapId).toBe(f.bapId)
    expect(ok.isValidRootForHeight).toHaveBeenCalledTimes(2)
  })

  it('keeps an unproven package without a header check', async () => {
    const f = bapIdentityFixture({})
    expect((await rememberConfirmedIssuerIdentityPackage('main', f.pkg, null))?.bapId).toBe(f.bapId)
  })

  it('stores verified packages from an envelope and ignores junk and overflow', async () => {
    const packages = Array.from({ length: MAX_ENVELOPE_IDENTITIES + 1 }, (_, i) => bapIdentityFixture({ name: `V${i}` }).pkg)
    expect(await rememberDeliveredIdentities('main', [{ v: 2 }, ...packages], null)).toBe(MAX_ENVELOPE_IDENTITIES - 1)
    expect(await rememberDeliveredIdentities('main', 'nope', null)).toBe(0)
  })
})
