import { BSM, PrivateKey, ProtoWallet, Utils, type ChainTracker } from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ values: new Map<string, string>() }))
vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => state.values.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    state.values.set(key, value)
    return true
  },
  durableRemoveItem: (key: string) => {
    state.values.delete(key)
  },
}))

import {
  identityCardFromWire,
  identityCardStatement,
  identityCardWire,
  isIdentityCardControl,
  IDENTITY_CARD_REQUEST,
  parseIdentityCard,
  peerIdentityFor,
  rememberIdentityCard,
  resetIdentityCardsForTests,
  signIdentityCard,
  type IdentityCardV1,
  type IdentityCardV2,
} from './identityCard'
import { identityKeyPackage, signIdentityProfile, type IdentityKeyPackage } from './identityProfile'
import { rememberIdentityProfile, resetIdentityProfilesForTests } from './identityProfiles'
import { bapIdentityFixture, beefOf, rotationTx } from './issuerIdentity.fixture'
import { buildIssuerIdentityPackage, issuerIdentityPackageBeef, type IssuerIdentityPackage } from './issuerIdentity'
import { rememberIssuerIdentityPackage, resetIssuerIdentitiesForTests } from './issuerIdentities'

const alice = PrivateKey.fromHex('0a'.padStart(64, '0'))
const mallory = PrivateKey.fromHex('0b'.padStart(64, '0'))
const studioKey = PrivateKey.fromHex('0c'.padStart(64, '0'))
const hex = (key: PrivateKey) => key.toHex().padStart(64, '0')
const pub = (key: PrivateKey) => key.toPublicKey().toString().toLowerCase()
const T0 = '2026-09-01T00:00:00.000Z'
const T1 = '2026-09-02T00:00:00.000Z'
const NOW = Date.parse('2026-10-01T00:00:00.000Z')
const png = { contentType: 'image/png', bytes: Uint8Array.from([137, 80, 78, 71, 1, 2, 3, 4]) }

const tracker = (valid = true): ChainTracker => ({
  isValidRootForHeight: vi.fn(async () => valid),
  currentHeight: async () => 1_000_000,
})

async function profilePackage(master: PrivateKey, name = 'Studio', issuedAt = T0): Promise<IdentityKeyPackage> {
  const { record } = await signIdentityProfile({ master, fields: { name, description: 'Prints' }, image: png, issuedAt })
  return identityKeyPackage(pub(master), { profile: record })!
}

const bapPart = (pkg: IssuerIdentityPackage) => ({ bapId: pkg.bapId, beefB64: pkg.beefB64 })

/** A card from a release that presented a BAP identity, countersigned by its BAP key. */
async function signV1Card(root: PrivateKey, issuedAt: string, presented?: { pkg: IssuerIdentityPackage; signingKey: PrivateKey }) {
  const bapId = presented?.pkg.bapId ?? null
  const statement = identityCardStatement({ v: 1, identityKey: pub(root), bapId, issuedAt })
  const { signature } = await new ProtoWallet(root).createSignature({
    data: statement,
    protocolID: [2, 'bap identity card'],
    keyID: '1',
    counterparty: 'anyone',
  })
  const card: IdentityCardV1 = { v: 1, identityKey: pub(root), bapId, issuedAt, identitySignature: Utils.toHex(signature) }
  if (!presented) return card
  return {
    ...card,
    package: presented.pkg,
    bapSigner: pub(presented.signingKey),
    bapSignature: BSM.sign(statement, presented.signingKey, 'base64') as string,
  }
}

function studio(name = 'Studio') {
  return bapIdentityFixture({ name, imageHeight: 900_001, aliasHeight: 900_002 })
}

beforeEach(() => {
  state.values.clear()
  resetIdentityCardsForTests()
  resetIssuerIdentitiesForTests()
  resetIdentityProfilesForTests()
})

describe('identity card', () => {
  it("presents the wallet key's own profile, signed by that key alone, with no header check", async () => {
    const card = await signIdentityCard({
      rootKeyHex: hex(alice),
      issuedAt: T0,
      presented: { pkg: await profilePackage(alice, 'Alice'), signingKey: alice },
    })
    expect(card.presentedSignature).toBeUndefined()
    const chain = tracker()
    const outcome = await rememberIdentityCard('main', card, { tracker: chain, expectedIdentityKey: pub(alice), now: NOW })
    expect(outcome).toMatchObject({
      kind: 'presented',
      identityKey: pub(alice),
      profile: { id: pub(alice), source: 'identity-key', name: 'Alice', description: 'Prints' },
    })
    expect(chain.isValidRootForHeight).not.toHaveBeenCalled()
    const peer = peerIdentityFor('main', pub(alice))
    expect(peer).toMatchObject({ kind: 'presented', profile: { id: pub(alice), name: 'Alice' } })
    expect(Array.from(peer?.kind === 'presented' ? peer.profile.image!.bytes : [])).toEqual(Array.from(png.bytes))
    expect(peerIdentityFor('test', pub(alice))).toBeNull()
  })

  it('presents another key this wallet controls only when that key countersigns', async () => {
    const card = await signIdentityCard({
      rootKeyHex: hex(alice),
      issuedAt: T0,
      presented: { pkg: await profilePackage(studioKey), signingKey: studioKey },
    })
    expect(card.presents).toBe(pub(studioKey))
    expect(await rememberIdentityCard('main', card, { tracker: null, now: NOW })).toMatchObject({
      kind: 'presented',
      identityKey: pub(alice),
      profile: { id: pub(studioKey), name: 'Studio' },
    })
    const unsigned: IdentityCardV2 = { ...card, presentedSignature: undefined }
    expect(await rememberIdentityCard('main', unsigned, { tracker: null, now: NOW })).toEqual({
      kind: 'refused',
      reason: 'malformed',
    })
    await expect(
      signIdentityCard({
        rootKeyHex: hex(mallory),
        issuedAt: T1,
        presented: { pkg: await profilePackage(studioKey), signingKey: mallory },
      }),
    ).rejects.toThrow(/does not match/)
  })

  it("a wallet cannot claim someone else's key by borrowing its signature or its profile", async () => {
    const real = await signIdentityCard({
      rootKeyHex: hex(alice),
      issuedAt: T0,
      presented: { pkg: await profilePackage(studioKey), signingKey: studioKey },
    })
    const claim = await signIdentityCard({ rootKeyHex: hex(mallory), issuedAt: T0 })
    const borrowed: IdentityCardV2 = {
      ...claim,
      presents: real.presents,
      package: real.package,
      presentedSignature: real.presentedSignature,
    }
    const statement = identityCardStatement(borrowed)
    const { signature } = await new ProtoWallet(mallory).createSignature({
      data: statement,
      protocolID: [2, 'identity card'],
      keyID: '1',
      counterparty: 'anyone',
    })
    expect(
      await rememberIdentityCard('main', { ...borrowed, identitySignature: Utils.toHex(signature) }, { tracker: null, now: NOW }),
    ).toEqual({ kind: 'refused', reason: 'presented-signature' })
    expect(peerIdentityFor('main', pub(mallory))).toBeNull()
  })

  it('refuses a card whose package carries no profile that verifies for the presented key', async () => {
    const card = await signIdentityCard({
      rootKeyHex: hex(alice),
      issuedAt: T0,
      presented: { pkg: await profilePackage(alice), signingKey: alice },
    })
    const forged = await profilePackage(mallory, 'Alice')
    const swapped: IdentityCardV2 = { ...card, package: { ...card.package!, certificates: forged.certificates } }
    expect(await rememberIdentityCard('main', swapped, { tracker: null, now: NOW })).toEqual({
      kind: 'refused',
      reason: 'profile',
    })
  })

  it("labels a key that has no profile of its own by the BAP profile linked to it, checked against headers", async () => {
    const f = bapIdentityFixture({ master: studioKey, name: 'BAP Studio', imageHeight: 900_001, aliasHeight: 900_002, linked: true, linkHeight: 900_003 })
    const pkg = identityKeyPackage(pub(studioKey), { bap: bapPart(f.pkg) })!
    const card = await signIdentityCard({ rootKeyHex: hex(alice), issuedAt: T0, presented: { pkg, signingKey: studioKey } })
    expect(await rememberIdentityCard('main', card, { tracker: tracker(false), now: NOW })).toEqual({
      kind: 'refused',
      reason: 'profile',
    })
    const chain = tracker()
    expect(await rememberIdentityCard('main', card, { tracker: chain, now: NOW })).toMatchObject({
      kind: 'presented',
      profile: { id: f.bapId, source: 'bap', identityKey: pub(studioKey), name: 'BAP Studio' },
    })
    expect(chain.isValidRootForHeight).toHaveBeenCalled()
    const own = await signIdentityProfile({ master: studioKey, fields: { name: 'Studio', description: '' }, issuedAt: T1 })
    rememberIdentityProfile('main', own)
    expect(peerIdentityFor('main', pub(alice))).toMatchObject({
      kind: 'presented',
      profile: { id: pub(studioKey), source: 'identity-key', name: 'Studio', bap: { bapId: f.bapId } },
    })
  })

  it('a contact keeps its presented profile however many strangers arrive later', async () => {
    const card = await signIdentityCard({
      rootKeyHex: hex(alice),
      issuedAt: T0,
      presented: { pkg: await profilePackage(alice, 'Alice'), signingKey: alice },
    })
    await rememberIdentityCard('main', card, { tracker: null, expectedIdentityKey: pub(alice), now: NOW })
    for (let i = 0; i < 12; i++) {
      const stranger = PrivateKey.fromRandom()
      rememberIdentityProfile('main', await signIdentityProfile({ master: stranger, fields: { name: `Stranger ${i}`, description: '' }, issuedAt: T0 }))
    }
    resetIdentityCardsForTests()
    resetIdentityProfilesForTests()
    expect(peerIdentityFor('main', pub(alice))).toMatchObject({ kind: 'presented', profile: { name: 'Alice' } })
  })

  it('refuses a card relayed by another sender', async () => {
    const card = await signIdentityCard({
      rootKeyHex: hex(alice),
      issuedAt: T0,
      presented: { pkg: await profilePackage(alice), signingKey: alice },
    })
    expect(
      await rememberIdentityCard('main', card, { tracker: null, expectedIdentityKey: pub(mallory), now: NOW }),
    ).toEqual({ kind: 'refused', reason: 'wrong-sender' })
  })

  it('a stolen card cannot be re-pointed at another wallet key', async () => {
    const card = await signIdentityCard({
      rootKeyHex: hex(alice),
      issuedAt: T0,
      presented: { pkg: await profilePackage(studioKey), signingKey: studioKey },
    })
    const stolen: IdentityCardV2 = { ...card, identityKey: pub(mallory) }
    expect(await rememberIdentityCard('main', stolen, { tracker: null, now: NOW })).toEqual({
      kind: 'refused',
      reason: 'identity-signature',
    })
  })

  it('a withdrawal replaces the link and an older card cannot be replayed over it', async () => {
    const presented = await signIdentityCard({
      rootKeyHex: hex(alice),
      issuedAt: T0,
      presented: { pkg: await profilePackage(alice), signingKey: alice },
    })
    const withdrawn = await signIdentityCard({ rootKeyHex: hex(alice), issuedAt: T1 })
    expect(await rememberIdentityCard('main', presented, { tracker: null, now: NOW })).toMatchObject({ kind: 'presented' })
    expect(await rememberIdentityCard('main', withdrawn, { tracker: null, now: NOW })).toEqual({
      kind: 'withdrawn',
      identityKey: pub(alice),
    })
    expect(peerIdentityFor('main', pub(alice))).toBeNull()
    expect(await rememberIdentityCard('main', presented, { tracker: null, now: NOW })).toEqual({
      kind: 'refused',
      reason: 'stale',
    })
  })

  it('the same statement may arrive again with a newer profile; a different key at the same time may not', async () => {
    const first = await signIdentityCard({
      rootKeyHex: hex(alice),
      issuedAt: T0,
      presented: { pkg: await profilePackage(alice, 'Alice'), signingKey: alice },
    })
    const renamed = await signIdentityCard({
      rootKeyHex: hex(alice),
      issuedAt: T0,
      presented: { pkg: await profilePackage(alice, 'Alice B', T1), signingKey: alice },
    })
    const swapped = await signIdentityCard({
      rootKeyHex: hex(alice),
      issuedAt: T0,
      presented: { pkg: await profilePackage(studioKey), signingKey: studioKey },
    })
    expect(await rememberIdentityCard('main', first, { tracker: null, now: NOW })).toMatchObject({ kind: 'presented' })
    expect(await rememberIdentityCard('main', renamed, { tracker: null, now: NOW })).toMatchObject({
      kind: 'presented',
      profile: { name: 'Alice B' },
    })
    expect(await rememberIdentityCard('main', first, { tracker: null, now: NOW })).toMatchObject({
      kind: 'presented',
      profile: { name: 'Alice B' },
    })
    expect(await rememberIdentityCard('main', swapped, { tracker: null, now: NOW })).toEqual({
      kind: 'refused',
      reason: 'stale',
    })
  })

  it('refuses cards dated in the future', async () => {
    const card = await signIdentityCard({ rootKeyHex: hex(alice), issuedAt: '2026-10-02T00:00:00.000Z' })
    expect(await rememberIdentityCard('main', card, { tracker: null, now: NOW })).toEqual({
      kind: 'refused',
      reason: 'future',
    })
  })

  it('parses strictly and round-trips the wire form', async () => {
    const card = await signIdentityCard({
      rootKeyHex: hex(alice),
      issuedAt: T0,
      presented: { pkg: await profilePackage(studioKey), signingKey: studioKey },
    })
    const wire = identityCardWire(card)
    expect(isIdentityCardControl(wire)).toBe(true)
    expect(isIdentityCardControl(IDENTITY_CARD_REQUEST)).toBe(true)
    expect(isIdentityCardControl('hello')).toBe(false)
    expect(parseIdentityCard(identityCardFromWire(wire))).toEqual(card)
    expect(identityCardFromWire('hello')).toBeUndefined()
    const withdrawn = await signIdentityCard({ rootKeyHex: hex(alice), issuedAt: T1 })
    expect(parseIdentityCard({ ...withdrawn, package: card.package })).toBeNull()
    expect(parseIdentityCard({ ...card, issuedAt: '2026-09-01T00:00:00Z' })).toBeNull()
    expect(parseIdentityCard({ ...card, identityKey: card.identityKey.toUpperCase() })).toBeNull()
    expect(parseIdentityCard({ ...card, package: await profilePackage(alice) })).toBeNull()
    expect(parseIdentityCard({ ...card, v: 3 })).toBeNull()
  })
})

describe('version 1 cards (BAP identity, earlier releases)', () => {
  it('links a wallet key to the identity both keys signed, checked against headers', async () => {
    const f = studio()
    const card = await signV1Card(alice, T0, { pkg: f.pkg, signingKey: f.signer })
    const chain = tracker()
    const outcome = await rememberIdentityCard('main', card, { tracker: chain, expectedIdentityKey: pub(alice), now: NOW })
    expect(outcome).toMatchObject({
      kind: 'presented',
      identityKey: pub(alice),
      profile: { id: f.bapId, source: 'bap', name: 'Studio' },
    })
    expect(chain.isValidRootForHeight).toHaveBeenCalled()
    expect(peerIdentityFor('main', pub(alice))).toMatchObject({ kind: 'presented', profile: { id: f.bapId } })
    resetIdentityCardsForTests()
    expect(peerIdentityFor('main', pub(alice))).toMatchObject({ kind: 'presented', profile: { id: f.bapId } })
  })

  it('a wallet cannot claim an identity whose BAP key it does not hold', async () => {
    const f = studio()
    const own = await signV1Card(mallory, T0, { pkg: f.pkg, signingKey: PrivateKey.fromRandom() })
    expect(await rememberIdentityCard('main', own, { tracker: tracker(), now: NOW })).toEqual({
      kind: 'refused',
      reason: 'signer',
    })
    const borrowed: IdentityCardV1 = { ...own, bapSigner: pub(f.signer) }
    expect(await rememberIdentityCard('main', borrowed, { tracker: tracker(), now: NOW })).toEqual({
      kind: 'refused',
      reason: 'bap-signature',
    })
    expect(peerIdentityFor('main', pub(mallory))).toBeNull()
  })

  it('a retired BAP key cannot vouch after a rotation', async () => {
    const f = studio()
    const { tx } = rotationTx(f, 1, { minedHeight: 900_003 })
    const rotated = buildIssuerIdentityPackage(f.bapId, [issuerIdentityPackageBeef(f.pkg), beefOf(tx)])!
    const card = await signV1Card(alice, T0, { pkg: rotated, signingKey: f.signer })
    expect(await rememberIdentityCard('main', card, { tracker: tracker(), now: NOW })).toEqual({
      kind: 'refused',
      reason: 'signer',
    })
  })

  it('refuses a package whose proofs do not match block headers', async () => {
    const f = studio()
    const card = await signV1Card(alice, T0, { pkg: f.pkg, signingKey: f.signer })
    expect(await rememberIdentityCard('main', card, { tracker: tracker(false), now: NOW })).toEqual({
      kind: 'refused',
      reason: 'package',
    })
    expect(await rememberIdentityCard('main', card, { tracker: null, now: NOW })).toEqual({
      kind: 'refused',
      reason: 'package',
    })
  })

  it('a v2 card at a later time replaces a v1 link, and the v1 card cannot come back', async () => {
    const f = studio()
    const v1 = await signV1Card(alice, T0, { pkg: f.pkg, signingKey: f.signer })
    rememberIssuerIdentityPackage('main', f.pkg)
    expect(await rememberIdentityCard('main', v1, { tracker: tracker(), now: NOW })).toMatchObject({ kind: 'presented' })
    const v2 = await signIdentityCard({
      rootKeyHex: hex(alice),
      issuedAt: T1,
      presented: { pkg: await profilePackage(alice, 'Alice'), signingKey: alice },
    })
    expect(await rememberIdentityCard('main', v2, { tracker: null, now: NOW })).toMatchObject({
      kind: 'presented',
      profile: { id: pub(alice) },
    })
    expect(await rememberIdentityCard('main', v1, { tracker: tracker(), now: NOW })).toEqual({
      kind: 'refused',
      reason: 'stale',
    })
  })
})
