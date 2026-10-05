import { BSM, PrivateKey, type ChainTracker } from '@bsv/sdk'
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
  type IdentityCard,
} from './identityCard'
import { bapIdentityFixture, beefOf, rotationTx } from './issuerIdentity.fixture'
import { buildIssuerIdentityPackage, issuerIdentityPackageBeef } from './issuerIdentity'
import { rememberIssuerIdentityPackage, resetIssuerIdentitiesForTests } from './issuerIdentities'

const alice = PrivateKey.fromHex('0a'.padStart(64, '0'))
const mallory = PrivateKey.fromHex('0b'.padStart(64, '0'))
const hex = (key: PrivateKey) => key.toHex().padStart(64, '0')
const pub = (key: PrivateKey) => key.toPublicKey().toString().toLowerCase()
const T0 = '2026-09-01T00:00:00.000Z'
const T1 = '2026-09-02T00:00:00.000Z'
const NOW = Date.parse('2026-10-01T00:00:00.000Z')

const tracker = (valid = true): ChainTracker => ({
  isValidRootForHeight: vi.fn(async () => valid),
  currentHeight: async () => 1_000_000,
})

function studio(name = 'Studio') {
  return bapIdentityFixture({ name, imageHeight: 900_001, aliasHeight: 900_002 })
}

beforeEach(() => {
  state.values.clear()
  resetIdentityCardsForTests()
  resetIssuerIdentitiesForTests()
})

describe('identity card', () => {
  it('links a wallet key to the identity both keys signed, checked against headers', async () => {
    const f = studio()
    const card = await signIdentityCard({
      rootKeyHex: hex(alice),
      issuedAt: T0,
      presented: { pkg: f.pkg, signingKey: f.signer },
    })
    const chain = tracker()
    const outcome = await rememberIdentityCard('main', card, { tracker: chain, expectedIdentityKey: pub(alice), now: NOW })
    expect(outcome).toMatchObject({ kind: 'presented', identityKey: pub(alice), identity: { bapId: f.bapId, name: 'Studio' } })
    expect(chain.isValidRootForHeight).toHaveBeenCalled()
    expect(peerIdentityFor('main', pub(alice))).toMatchObject({ kind: 'presented', identity: { bapId: f.bapId } })
    expect(peerIdentityFor('test', pub(alice))).toBeNull()
  })

  it('a contact keeps its presented identity however many strangers arrive later', async () => {
    const f = studio()
    const card = await signIdentityCard({
      rootKeyHex: hex(alice),
      issuedAt: T0,
      presented: { pkg: f.pkg, signingKey: f.signer },
    })
    await rememberIdentityCard('main', card, { tracker: tracker(), expectedIdentityKey: pub(alice), now: NOW })
    for (let i = 0; i < 12; i++) rememberIssuerIdentityPackage('main', bapIdentityFixture({ name: `Stranger ${i}` }).pkg)
    resetIdentityCardsForTests()
    resetIssuerIdentitiesForTests()
    expect(peerIdentityFor('main', pub(alice))).toMatchObject({ kind: 'presented', identity: { bapId: f.bapId } })
  })

  it('refuses a card relayed by another sender', async () => {
    const f = studio()
    const card = await signIdentityCard({ rootKeyHex: hex(alice), issuedAt: T0, presented: { pkg: f.pkg, signingKey: f.signer } })
    expect(
      await rememberIdentityCard('main', card, { tracker: tracker(), expectedIdentityKey: pub(mallory), now: NOW }),
    ).toEqual({ kind: 'refused', reason: 'wrong-sender' })
  })

  it('a stolen card cannot be re-pointed at another wallet key', async () => {
    const f = studio()
    const card = await signIdentityCard({ rootKeyHex: hex(alice), issuedAt: T0, presented: { pkg: f.pkg, signingKey: f.signer } })
    const stolen: IdentityCard = { ...card, identityKey: pub(mallory) }
    expect(await rememberIdentityCard('main', stolen, { tracker: tracker(), now: NOW })).toEqual({
      kind: 'refused',
      reason: 'identity-signature',
    })
  })

  it('a wallet cannot claim an identity whose BAP key it does not hold', async () => {
    const f = studio()
    const own = await signIdentityCard({
      rootKeyHex: hex(mallory),
      issuedAt: T0,
      presented: { pkg: f.pkg, signingKey: PrivateKey.fromRandom() },
    })
    expect(await rememberIdentityCard('main', own, { tracker: tracker(), now: NOW })).toEqual({
      kind: 'refused',
      reason: 'signer',
    })
    const borrowed: IdentityCard = { ...own, bapSigner: pub(f.signer) }
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
    const card = await signIdentityCard({ rootKeyHex: hex(alice), issuedAt: T0, presented: { pkg: rotated, signingKey: f.signer } })
    expect(await rememberIdentityCard('main', card, { tracker: tracker(), now: NOW })).toEqual({
      kind: 'refused',
      reason: 'signer',
    })
  })

  it('refuses a package whose proofs do not match block headers', async () => {
    const f = studio()
    const card = await signIdentityCard({ rootKeyHex: hex(alice), issuedAt: T0, presented: { pkg: f.pkg, signingKey: f.signer } })
    expect(await rememberIdentityCard('main', card, { tracker: tracker(false), now: NOW })).toEqual({
      kind: 'refused',
      reason: 'package',
    })
    expect(await rememberIdentityCard('main', card, { tracker: null, now: NOW })).toEqual({
      kind: 'refused',
      reason: 'package',
    })
  })

  it('a withdrawal replaces the link and an older card cannot be replayed over it', async () => {
    const f = studio()
    const presented = await signIdentityCard({ rootKeyHex: hex(alice), issuedAt: T0, presented: { pkg: f.pkg, signingKey: f.signer } })
    const withdrawn = await signIdentityCard({ rootKeyHex: hex(alice), issuedAt: T1 })
    expect(await rememberIdentityCard('main', presented, { tracker: tracker(), now: NOW })).toMatchObject({ kind: 'presented' })
    expect(await rememberIdentityCard('main', withdrawn, { tracker: tracker(), now: NOW })).toEqual({
      kind: 'withdrawn',
      identityKey: pub(alice),
    })
    expect(peerIdentityFor('main', pub(alice))).toBeNull()
    expect(await rememberIdentityCard('main', presented, { tracker: tracker(), now: NOW })).toEqual({
      kind: 'refused',
      reason: 'stale',
    })
  })

  it('the same statement may arrive again with a newer package; a different identity at the same time may not', async () => {
    const f = studio()
    const other = studio('Other')
    const first = await signIdentityCard({ rootKeyHex: hex(alice), issuedAt: T0, presented: { pkg: f.pkg, signingKey: f.signer } })
    const again = await signIdentityCard({ rootKeyHex: hex(alice), issuedAt: T0, presented: { pkg: f.pkg, signingKey: f.signer } })
    const swapped = await signIdentityCard({
      rootKeyHex: hex(alice),
      issuedAt: T0,
      presented: { pkg: other.pkg, signingKey: other.signer },
    })
    expect(await rememberIdentityCard('main', first, { tracker: tracker(), now: NOW })).toMatchObject({ kind: 'presented' })
    expect(await rememberIdentityCard('main', again, { tracker: tracker(), now: NOW })).toMatchObject({ kind: 'presented' })
    expect(await rememberIdentityCard('main', swapped, { tracker: tracker(), now: NOW })).toEqual({
      kind: 'refused',
      reason: 'stale',
    })
  })

  it('refuses cards dated in the future', async () => {
    const card = await signIdentityCard({ rootKeyHex: hex(alice), issuedAt: '2026-10-02T00:00:00.000Z' })
    expect(await rememberIdentityCard('main', card, { tracker: tracker(), now: NOW })).toEqual({
      kind: 'refused',
      reason: 'future',
    })
  })

  it('both signatures cover the same statement, BAP-style', async () => {
    const f = studio()
    const card = await signIdentityCard({ rootKeyHex: hex(alice), issuedAt: T0, presented: { pkg: f.pkg, signingKey: f.signer } })
    expect(card.bapSignature).toBe(BSM.sign(identityCardStatement(card), f.signer, 'base64'))
  })

  it('parses strictly and round-trips the wire form', async () => {
    const f = studio()
    const card = await signIdentityCard({ rootKeyHex: hex(alice), issuedAt: T0, presented: { pkg: f.pkg, signingKey: f.signer } })
    const wire = identityCardWire(card)
    expect(isIdentityCardControl(wire)).toBe(true)
    expect(isIdentityCardControl(IDENTITY_CARD_REQUEST)).toBe(true)
    expect(isIdentityCardControl('hello')).toBe(false)
    expect(parseIdentityCard(identityCardFromWire(wire))).toEqual(card)
    expect(identityCardFromWire('hello')).toBeUndefined()
    const withdrawn = await signIdentityCard({ rootKeyHex: hex(alice), issuedAt: T1 })
    expect(parseIdentityCard({ ...withdrawn, package: f.pkg })).toBeNull()
    expect(parseIdentityCard({ ...card, issuedAt: '2026-09-01T00:00:00Z' })).toBeNull()
    expect(parseIdentityCard({ ...card, identityKey: card.identityKey.toUpperCase() })).toBeNull()
    expect(parseIdentityCard({ ...card, package: studio('Other').pkg })).toBeNull()
  })
})
