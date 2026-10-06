import { PrivateKey } from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PresentedIdentityMaterial } from './publicIdentities'

const state = vi.hoisted(() => ({
  values: new Map<string, string>(),
  friends: new Map<string, { id: string; identityKey: string; messagebox?: string }>(),
  material: null as PresentedIdentityMaterial | null,
  delivered: [] as Array<{ recipientIdentityKey: string; body: string; messagebox?: string | null }>,
  reach: 'cloud' as 'local' | 'cloud' | 'direct',
  runtime: null as unknown,
  accounts: [] as Array<{ master: string; identityKey: string; index: number }>,
  accountIdentities: new Map<string, unknown>(),
}))
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
vi.mock('./friends', () => ({
  getFriendByIdentityKey: (key: string) => state.friends.get(key.toLowerCase()) ?? null,
}))
vi.mock('./walletRuntime', () => ({
  getWalletRuntime: () => state.runtime,
  runtimeIsCurrent: () => true,
}))
vi.mock('./publicIdentities', () => ({
  presentedIdentityMaterial: () => state.material,
  presentedIdentityOfAccount: (scope: { identityKey: string; accountIndex?: number; chain: string }) =>
    state.accountIdentities.get(`${scope.chain}:${scope.accountIndex}:${scope.identityKey}`) ?? null,
}))
vi.mock('./vaultAccounts', () => ({
  findVaultAccountByIdentityKey: (master: string, key: string) =>
    state.accounts.find((a) => a.master === master && a.identityKey === key.toLowerCase()) ?? null,
}))
vi.mock('./messageTransport', () => ({
  MESSAGEBOX_INNER_MAX: 160_000,
  deliveryReachedPeer: (delivered: string) => delivered !== 'local',
  deliverOutbound: vi.fn(async (env: { recipientIdentityKey: string; body: string; messagebox?: string | null }) => {
    state.delivered.push(env)
    return { delivered: state.reach, messagebox: env.messagebox ?? 'box' }
  }),
}))

import {
  exchangeIdentityCards,
  ingestIdentityCardBody,
  resetIdentityCardShareForTests,
  shareIdentityCardAfterDelivery,
  siblingAccountIdentity,
} from './identityCardShare'
import { IDENTITY_CARD_REQUEST, identityCardFromWire, parseIdentityCard } from './identityCard'
import { bapIdentityFixture } from './issuerIdentity.fixture'

const me = PrivateKey.fromHex('0c'.padStart(64, '0'))
const friendKey = PrivateKey.fromHex('0d'.padStart(64, '0')).toPublicKey().toString().toLowerCase()
const strangerKey = PrivateKey.fromHex('0e'.padStart(64, '0')).toPublicKey().toString().toLowerCase()
const meHex = me.toHex().padStart(64, '0')
const master = PrivateKey.fromHex('0b'.padStart(64, '0'))
const masterKey = master.toPublicKey().toString()
const siblingKey = PrivateKey.fromHex('0f'.padStart(64, '0')).toPublicKey().toString().toLowerCase()
const fixture = bapIdentityFixture({ name: 'Me' })

function presented(issuedAt = '2026-09-01T00:00:00.000Z'): PresentedIdentityMaterial {
  return {
    kind: 'presented',
    issuedAt,
    pkg: fixture.pkg,
    identity: { bapId: fixture.bapId, alias: { txid: fixture.aliasTx.id('hex') } } as never,
    signingKey: fixture.signer,
  }
}

const sent = (to: string, body = 'hello') =>
  shareIdentityCardAfterDelivery({
    recipientIdentityKey: to,
    senderIdentityKey: me.toPublicKey().toString(),
    rootKeyHex: meHex,
    body,
    peerId: to,
  })

const cards = () => state.delivered.filter((env) => env.body !== IDENTITY_CARD_REQUEST)

beforeEach(() => {
  state.values.clear()
  state.friends.clear()
  state.friends.set(friendKey, { id: 'f1', identityKey: friendKey, messagebox: 'https://box.example' })
  state.material = presented()
  state.delivered = []
  state.reach = 'cloud'
  state.runtime = {
    instance: {
      identityKey: me.toPublicKey().toString(),
      rootKeyHex: meHex,
      masterRootKeyHex: master.toHex().padStart(64, '0'),
      chain: 'main',
      accountIndex: 0,
    },
  }
  state.accounts = [{ master: masterKey, identityKey: siblingKey, index: 2 }]
  state.accountIdentities.clear()
  resetIdentityCardShareForTests()
})

describe('identity card sharing', () => {
  it('sends a contact the card once per version, to their own box', async () => {
    await sent(friendKey)
    await sent(friendKey)
    expect(cards()).toHaveLength(1)
    expect(cards()[0]).toMatchObject({ recipientIdentityKey: friendKey, messagebox: 'https://box.example' })
    const card = parseIdentityCard(identityCardFromWire(cards()[0]!.body))
    expect(card).toMatchObject({ identityKey: me.toPublicKey().toString().toLowerCase(), bapId: fixture.bapId })
    state.material = presented('2026-09-02T00:00:00.000Z')
    await sent(friendKey)
    expect(cards()).toHaveLength(2)
  })

  it('never volunteers a card to a stranger or a market counterparty', async () => {
    await sent(strangerKey)
    expect(state.delivered).toEqual([])
  })

  it('records nothing when the card did not reach the peer, so the next delivery retries', async () => {
    state.reach = 'local'
    await sent(friendKey)
    state.reach = 'cloud'
    await sent(friendKey)
    expect(cards()).toHaveLength(2)
  })

  it('withdraws only from contacts who saw a card', async () => {
    state.material = { kind: 'withdrawn', issuedAt: '2026-09-02T00:00:00.000Z' }
    await sent(friendKey)
    expect(cards()).toHaveLength(0)
    state.material = presented()
    await sent(friendKey)
    state.material = { kind: 'withdrawn', issuedAt: '2026-09-03T00:00:00.000Z' }
    await sent(friendKey)
    expect(parseIdentityCard(identityCardFromWire(cards()[1]!.body))).toMatchObject({ bapId: null })
  })

  it('answers card requests from contacts only, at a bounded rate', async () => {
    await ingestIdentityCardBody(strangerKey, IDENTITY_CARD_REQUEST)
    expect(state.delivered).toEqual([])
    await ingestIdentityCardBody(friendKey, IDENTITY_CARD_REQUEST)
    await ingestIdentityCardBody(friendKey, IDENTITY_CARD_REQUEST)
    expect(cards()).toHaveLength(1)
  })

  it('a new contact gets our card and is asked for theirs', async () => {
    await exchangeIdentityCards({ identityKey: friendKey, messagebox: 'https://box.example' })
    expect(state.delivered.map((env) => (env.body === IDENTITY_CARD_REQUEST ? 'request' : 'card'))).toEqual([
      'card',
      'request',
    ])
  })

  it('counts another account of this vault as a contact: answers its asks and volunteers the card', async () => {
    await ingestIdentityCardBody(siblingKey, IDENTITY_CARD_REQUEST)
    expect(cards()).toHaveLength(1)
    expect(cards()[0]).toMatchObject({ recipientIdentityKey: siblingKey, messagebox: null })
    state.material = presented('2026-09-02T00:00:00.000Z')
    await sent(siblingKey)
    expect(cards()).toHaveLength(2)
  })

  it('does not treat an account of a different vault as a sibling', async () => {
    state.accounts = [{ master: strangerKey, identityKey: siblingKey, index: 2 }]
    await ingestIdentityCardBody(siblingKey, IDENTITY_CARD_REQUEST)
    expect(state.delivered).toEqual([])
    expect(siblingAccountIdentity('main', siblingKey)).toBeNull()
  })

  it("reads a sibling account's presented identity on this device, per chain", () => {
    const identity = { bapId: 'sibling-bap', name: 'Sub' }
    state.accountIdentities.set(`main:2:${siblingKey}`, identity)
    expect(siblingAccountIdentity('main', siblingKey.toUpperCase())).toBe(identity)
    expect(siblingAccountIdentity('test', siblingKey)).toBeNull()
    expect(siblingAccountIdentity('main', friendKey)).toBeNull()
    expect(siblingAccountIdentity('main', me.toPublicKey().toString())).toBeNull()
  })

  it('does not share in reply to its own card traffic', async () => {
    await sent(friendKey, IDENTITY_CARD_REQUEST)
    expect(state.delivered).toEqual([])
  })
})
