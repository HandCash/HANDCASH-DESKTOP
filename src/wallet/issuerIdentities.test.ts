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

import { bapAliasScript, bapIdScript, bapKey, BAP_REVOKED_ADDRESS } from './bapRecords'
import { identityLinkScript, identityLinkScriptMaxBytes, parseIdentityLink } from './identityLink'
import { bapIdentityFixture, beefOf, linkTx, recordTx, rotationTx } from './issuerIdentity.fixture'
import {
  bapStampVerdict,
  holdIssuerIdentities,
  issuerIdentityFor,
  issuerIdentityForSigner,
  issuerIdentityPackage,
  linkedIdentityKey,
  linkedIssuerIdentity,
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
  verifyIssuerIdentityPackage,
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
  it('writes only the identity key, still reads an earlier draft\'s BAP ID, and ignores self-asserted profiles', () => {
    const lock = '76a914' + '00'.repeat(20) + '88ac'
    const issuer = pub(PrivateKey.fromRandom())
    const { bapId } = bapIdentityFixture({})
    expect(issuerMetadataFromScript(appendIssuerMetadata(lock, issuer))).toEqual({ issuer })
    const earlier = new Script()
    earlier.writeOpCode(0x6a)
    for (const field of ['1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5', 'SET', 'issuer', issuer, 'bapId', bapId])
      earlier.writeBin(Utils.toArray(field, 'utf8'))
    expect(issuerMetadataFromScript(lock + earlier.toHex())).toEqual({ issuer, bapId })
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
    expect(bapStampVerdict('main', { bapId: f.bapId, signer: pub(f.signer), minedHeight: 900_015 })).toEqual({
      kind: 'unconfirmed',
      bapId: f.bapId,
      reason: 'no-package',
    })
    expect(bapStampVerdict('main', { bapId: 'not-a-bap-id', signer: stranger })).toBeNull()
    const { tx } = rotationTx(f, 1, { name: 'Studio II', minedHeight: 900_020 })
    rememberIssuerIdentityPackage('main', buildIssuerIdentityPackage(f.bapId, [issuerIdentityPackageBeef(f.pkg), beefOf(tx)])!)
    const old = (minedHeight?: number) => bapStampVerdict('main', { bapId: f.bapId, signer: pub(f.signer), minedHeight })
    expect(old(900_015)).toMatchObject({ kind: 'verified', identity: { name: 'Studio II' } })
    expect(old(900_030)).toEqual({ kind: 'refused', bapId: f.bapId, reason: 'retired-key' })
    expect(old()).toEqual({ kind: 'unconfirmed', bapId: f.bapId, reason: 'height-unknown' })
    expect(bapStampVerdict('main', { bapId: f.bapId, signer: stranger, minedHeight: 900_015 })).toEqual({
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

  it('never evicts a package a persisted list names, whatever its age', () => {
    const contact = bapIdentityFixture({ name: 'Contact' })
    const issuer = bapIdentityFixture({ name: 'Token issuer' })
    rememberIssuerIdentityPackage('main', contact.pkg)
    rememberIssuerIdentityPackage('main', issuer.pkg)
    holdIssuerIdentities('main', 'contacts', [contact.bapId, null, 'not-a-bap-id'])
    holdIssuerIdentities('main', 'tokens:account-0', [issuer.bapId, issuer.bapId])
    for (let i = 0; i < 12; i++) rememberIssuerIdentityPackage('main', bapIdentityFixture({ name: `Peer ${i}` }).pkg)
    resetIssuerIdentitiesForTests()
    expect(issuerIdentityFor('main', contact.bapId)?.name).toBe('Contact')
    expect(issuerIdentityFor('main', issuer.bapId)?.name).toBe('Token issuer')
    const entries = [...state.values.keys()].filter((key) => /:main:[1-9A-HJ-NP-Za-km-z]+$/.test(key))
    expect(entries.length).toBe(10)
  })

  it('a package stays held while any list still names it', () => {
    const shared = bapIdentityFixture({ name: 'Shared' })
    rememberIssuerIdentityPackage('main', shared.pkg)
    holdIssuerIdentities('main', 'tokens:account-0', [shared.bapId])
    holdIssuerIdentities('main', 'items:account-1', [shared.bapId])
    holdIssuerIdentities('main', 'tokens:account-0', [])
    for (let i = 0; i < 9; i++) rememberIssuerIdentityPackage('main', bapIdentityFixture({ name: `Peer ${i}` }).pkg)
    expect(issuerIdentityPackage('main', shared.bapId)).not.toBeNull()
    holdIssuerIdentities('main', 'items:account-1', [])
    rememberIssuerIdentityPackage('main', bapIdentityFixture({ name: 'Newest' }).pkg)
    expect(issuerIdentityPackage('main', shared.bapId)).toBeNull()
  })

  it('a hold that names nothing new writes nothing', () => {
    const f = bapIdentityFixture({})
    rememberIssuerIdentityPackage('main', f.pkg)
    holdIssuerIdentities('main', 'contacts', [f.bapId])
    const index = [...state.values.entries()].find(([key]) => key.endsWith(':main'))![1]
    state.writable = false
    holdIssuerIdentities('main', 'contacts', [f.bapId, f.bapId])
    state.writable = true
    expect([...state.values.entries()].find(([key]) => key.endsWith(':main'))![1]).toBe(index)
    expect(JSON.parse(index).holds).toEqual({ contacts: [f.bapId] })
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

  it('keeps a v2 package only when its BAP profile links the identity key it names', async () => {
    const f = bapIdentityFixture({ name: 'Linked', linked: true })
    const v2 = (identityKey: string) => ({ v: 2, identityKey, bap: { bapId: f.pkg.bapId, beefB64: f.pkg.beefB64 } })
    expect(await rememberDeliveredIdentities('main', [v2(pub(PrivateKey.fromRandom()))], null)).toBe(0)
    expect(issuerIdentityPackage('main', f.bapId)).toBeNull()
    expect(await rememberDeliveredIdentities('main', [v2(pub(f.master))], null)).toBe(1)
    expect(linkedIssuerIdentity('main', pub(f.master))?.name).toBe('Linked')
  })
})

describe('identity links', () => {
  it('verifies both signatures over the input the record names, and nothing else', () => {
    const f = bapIdentityFixture({})
    const tx = linkTx(f, f.master)
    expect(parseIdentityLink(tx, 0)).toEqual({
      kind: 'link',
      identityKey: pub(f.master),
      bapId: f.bapId,
      bapSigner: f.signer.toAddress(),
    })
    const elsewhere = linkTx(f, f.master)
    tx.inputs[0]!.sourceTXID = elsewhere.inputs[0]!.sourceTXID ?? elsewhere.inputs[0]!.sourceTransaction!.id('hex')
    tx.inputs[0]!.sourceTransaction = undefined
    expect(parseIdentityLink(tx, 0)).toBeNull()
  })

  it('never quotes a link script smaller than one it signs', () => {
    for (let i = 0; i < 16; i++) {
      const f = bapIdentityFixture({})
      const identityKey = pub(f.master)
      const script = identityLinkScript({
        kind: 'link',
        identityKey,
        bapId: f.bapId,
        signers: [
          { kind: 'identity', key: f.master },
          { kind: 'bap', key: f.signer },
        ],
        anchor: { txid: 'ab'.repeat(32), vout: i },
      })
      expect(script.length / 2).toBeLessThanOrEqual(identityLinkScriptMaxBytes(identityKey, f.bapId, f.signer.toAddress()))
    }
  })

  it('refuses a link one party signed alone, or signed for another identity key', () => {
    const f = bapIdentityFixture({})
    const anchor = { txid: 'ab'.repeat(32), vout: 0 }
    const identityKey = pub(f.master)
    expect(() =>
      identityLinkScript({ kind: 'link', identityKey, bapId: f.bapId, signers: [{ kind: 'bap', key: f.signer }], anchor }),
    ).toThrow(/identity key then a BAP key/)
    expect(() =>
      identityLinkScript({
        kind: 'link',
        identityKey,
        bapId: f.bapId,
        signers: [
          { kind: 'identity', key: PrivateKey.fromRandom() },
          { kind: 'bap', key: f.signer },
        ],
        anchor,
      }),
    ).toThrow(/another identity key/)
  })

  it('labels the identity key a package links, and only that key', () => {
    const f = bapIdentityFixture({ name: 'Studio', linked: true, aliasHeight: 900_010, linkHeight: 900_011 })
    rememberIssuerIdentityPackage('main', f.pkg)
    expect(issuerIdentityFor('main', f.bapId)?.links).toEqual([
      { identityKey: pub(f.master), txid: f.linkTx!.id('hex'), minedHeight: 900_011 },
    ])
    expect(linkedIssuerIdentity('main', pub(f.master))?.name).toBe('Studio')
    expect(linkedIssuerIdentity('main', pub(PrivateKey.fromRandom()))).toBeNull()
    expect(linkedIdentityKey(issuerIdentityFor('main', f.bapId)!)).toBe(pub(f.master))
  })

  it('ignores a link by a key outside the chain or one retired before the link was mined', () => {
    const f = bapIdentityFixture({ aliasHeight: 900_010 })
    const rotation = rotationTx(f, 1, { minedHeight: 900_020 })
    const stranger = linkTx(f, f.master, { bapSeq: 7, minedHeight: 900_021 })
    const retired = linkTx(f, f.master, { bapSeq: 1, minedHeight: 900_030 })
    const pkg = buildIssuerIdentityPackage(f.bapId, [...f.beefs, beefOf(rotation.tx), beefOf(stranger), beefOf(retired)])!
    expect(verifyIssuerIdentityPackage(pkg)?.links).toEqual([])
    const before = linkTx(f, f.master, { bapSeq: 1, minedHeight: 900_015 })
    const kept = buildIssuerIdentityPackage(f.bapId, [...f.beefs, beefOf(rotation.tx), beefOf(before)])!
    expect(verifyIssuerIdentityPackage(kept)?.links.map((link) => link.txid)).toEqual([before.id('hex')])
  })

  it('an unlink by either party ends links mined at or before it; an older unlink does not', () => {
    const f = bapIdentityFixture({ aliasHeight: 900_010, linked: true, linkHeight: 900_020 })
    const byIdentity = linkTx(f, f.master, {
      kind: 'unlink',
      signers: [{ kind: 'identity', key: f.master }],
      minedHeight: 900_030,
    })
    const byBap = linkTx(f, f.master, { kind: 'unlink', signers: [{ kind: 'bap', key: f.signer }], minedHeight: 900_040 })
    const older = linkTx(f, f.master, { kind: 'unlink', signers: [{ kind: 'bap', key: f.signer }], minedHeight: 900_015 })
    const links = (...txs: ReturnType<typeof linkTx>[]) =>
      verifyIssuerIdentityPackage(buildIssuerIdentityPackage(f.bapId, [...f.beefs, ...txs.map((tx) => beefOf(tx))])!)?.links
    expect(links(byIdentity)).toEqual([])
    expect(links(byBap)).toEqual([])
    expect(links(older)).toHaveLength(1)
    const pkg = buildIssuerIdentityPackage(f.bapId, [...f.beefs, beefOf(byIdentity)])!
    const relinked = buildIssuerIdentityPackage(f.bapId, [
      issuerIdentityPackageBeef(pkg),
      beefOf(linkTx(f, f.master, { minedHeight: 900_050 })),
    ])!
    expect(verifyIssuerIdentityPackage(relinked)?.links.map((link) => link.minedHeight)).toEqual([900_050])
  })

  it('a revocation ends every link', () => {
    const f = bapIdentityFixture({ aliasHeight: 900_010, linked: true, linkHeight: 900_020 })
    const revoke = recordTx([bapIdScript({ bapId: f.bapId, address: BAP_REVOKED_ADDRESS, signer: bapKey(f.master, 0) })], 900_030)
    const identity = verifyIssuerIdentityPackage(buildIssuerIdentityPackage(f.bapId, [...f.beefs, beefOf(revoke)])!)
    expect(identity?.revoked).toBeDefined()
    expect(identity?.links).toEqual([])
  })

  it('the latest mined link wins across profiles; a tie names none; an unmined link stands in only alone', () => {
    const identity = PrivateKey.fromRandom()
    const older = bapIdentityFixture({ name: 'Older', identity, linkHeight: 900_010 })
    const newer = bapIdentityFixture({ name: 'Newer', identity, linkHeight: 900_020 })
    rememberIssuerIdentityPackage('main', older.pkg)
    rememberIssuerIdentityPackage('main', newer.pkg)
    expect(linkedIssuerIdentity('main', pub(identity))?.name).toBe('Newer')
    rememberIssuerIdentityPackage('main', bapIdentityFixture({ name: 'Pending', identity }).pkg)
    expect(linkedIssuerIdentity('main', pub(identity))?.name).toBe('Newer')
    rememberIssuerIdentityPackage('main', bapIdentityFixture({ name: 'Tied', identity, linkHeight: 900_020 }).pkg)
    expect(linkedIssuerIdentity('main', pub(identity))).toBeNull()
    const alone = PrivateKey.fromRandom()
    rememberIssuerIdentityPackage('main', bapIdentityFixture({ name: 'Unmined', identity: alone }).pkg)
    expect(linkedIssuerIdentity('main', pub(alone))?.name).toBe('Unmined')
  })

  it('a list naming an identity key holds the profile that links it', () => {
    const f = bapIdentityFixture({ name: 'Issuer', linked: true })
    rememberIssuerIdentityPackage('main', f.pkg)
    holdIssuerIdentities('main', 'items:account-0', [pub(f.master)])
    for (let i = 0; i < 12; i++) rememberIssuerIdentityPackage('main', bapIdentityFixture({ name: `Peer ${i}` }).pkg)
    expect(issuerIdentityPackage('main', f.bapId)).not.toBeNull()
  })
})
