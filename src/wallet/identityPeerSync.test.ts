import { PrivateKey } from '@bsv/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { durableForgetCached } from './durableStorage'
import { identityCardsGeneration, peerIdentityFor, resetIdentityCardsForTests } from './identityCard'
import { signIdentityProfile } from './identityProfile'
import { identityProfileFor, rememberIdentityProfile, resetIdentityProfilesForTests } from './identityProfiles'
import { resetIssuerIdentitiesForTests } from './issuerIdentities'
import {
  exportLocalIdentityBundle,
  mergeRemoteIdentityBundle,
  requestIdentitiesOverVaultLink,
  resetIdentityPeerSyncForTests,
  startVaultLinkIdentitySync,
} from './identityPeerSync'
import { DEVICE_PEER_AUTH_HEADER, createDeviceAuth, openFromPeer } from './devicePeerAuth'

const root = PrivateKey.fromRandom()
const rootKeyHex = root.toHex()
const identityKey = root.toPublicKey().toString().toLowerCase()
const issuerKey = PrivateKey.fromRandom()
const issuerPub = issuerKey.toPublicKey().toString().toLowerCase()

vi.mock('./session', () => ({
  getActiveWallet: () => ({
    chain: 'main',
    accountIndex: 0,
    identityKey,
    address: '1LocalAddr',
    rootKeyHex,
    wallet: {},
  }),
  fetchBalanceSats: async () => 50_000,
}))
vi.mock('./friends', () => ({ listFriends: () => [] }))
vi.mock('./collectables', () => ({ listCollectables: async () => [] }))
vi.mock('./deviceWallets', () => ({
  enrollLocalDevice: (args: { identityKey: string; platform: string }) => ({
    ...args,
    deviceId: 'desk-a',
    label: 'Desk A',
  }),
  buildPairPayload: (args: object) => ({ v: 3, ...args, deviceId: 'desk-a' }),
  getOrCreateDeviceId: () => 'desk-a',
  listDeviceWallets: () => [],
}))
vi.mock('./scanLogin/receiver', () => ({
  isScanLoginPath: () => false,
  handleScanLoginRequestAsync: vi.fn(),
}))

const linkListeners = new Set<(body: string, device: string) => void>()
const sentFrames: Array<{ device: string; body: string }> = []
vi.mock('./vaultLink', () => ({
  onVaultLinkMessage: (fn: (body: string, device: string) => void) => {
    linkListeners.add(fn)
    return () => linkListeners.delete(fn)
  },
  sendOverVaultLink: async (device: string, body: string) => {
    sentFrames.push({ device, body })
    return 'direct' as const
  },
  vaultLinkOpen: (device: string) => device === 'peer-phone',
  openVaultLinkDevices: () => ['peer-phone'],
}))

const memStore = new Map<string, string>()
function clearStore() {
  memStore.clear()
  durableForgetCached()
}

describe('identityPeerSync & /handcash-device/v1/identities', { timeout: 30_000 }, () => {
  beforeEach(() => {
    clearStore()
    resetIdentityProfilesForTests()
    resetIssuerIdentitiesForTests()
    resetIdentityCardsForTests()
    resetIdentityPeerSyncForTests()
    linkListeners.clear()
    sentFrames.length = 0
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => memStore.get(k) ?? null,
      setItem: (k: string, v: string) => {
        memStore.set(k, v)
      },
      removeItem: (k: string) => {
        memStore.delete(k)
      },
      clear: () => memStore.clear(),
      key: (i: number) => Array.from(memStore.keys())[i] ?? null,
      get length() {
        return memStore.size
      },
    })
    vi.stubGlobal('window', { handcash: { platform: 'linux' } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('exports verified BRC-248 profiles and merges them onto a peer device with empty storage', async () => {
    const signed = await signIdentityProfile({
      master: issuerKey,
      fields: { name: 'Studio Nova', description: 'Original digital art' },
      issuedAt: new Date(Date.now() - 1_000).toISOString(),
    })
    expect(rememberIdentityProfile('main', signed)).toBe(true)

    const bundle = exportLocalIdentityBundle({
      chain: 'main',
      accountIndex: 0,
      identityKey,
    })
    expect(bundle.profiles).toHaveLength(1)
    expect(bundle.profiles[0]?.identityKey).toBe(issuerPub)

    // Simulate a second device that does not have the profile yet
    clearStore()
    resetIdentityProfilesForTests()
    expect(identityProfileFor('main', issuerPub)).toBeNull()

    const merged = await mergeRemoteIdentityBundle('main', bundle)
    expect(merged.profilesAdded).toBe(1)
    const restored = identityProfileFor('main', issuerPub)
    expect(restored?.name).toBe('Studio Nova')
    expect(restored?.description).toBe('Original digital art')
  })

  it('rejects tampered profile certificates during merge', async () => {
    const signed = await signIdentityProfile({
      master: issuerKey,
      fields: { name: 'Real Studio', description: '' },
      issuedAt: new Date(Date.now() - 1_000).toISOString(),
    })
    expect(rememberIdentityProfile('main', signed)).toBe(true)
    const bundle = exportLocalIdentityBundle({ chain: 'main', accountIndex: 0, identityKey })
    bundle.profiles[0]!.record.certificate.signature = '00'.repeat(32)

    clearStore()
    resetIdentityProfilesForTests()
    const merged = await mergeRemoteIdentityBundle('main', bundle)
    expect(merged.profilesAdded).toBe(0)
    expect(identityProfileFor('main', issuerPub)).toBeNull()
  })

  it('serves authenticated, sealed /handcash-device/v1/identities via devicePeerHandler', async () => {
    const signed = await signIdentityProfile({
      master: issuerKey,
      fields: { name: 'Peer Issuer', description: 'Served over LAN' },
      issuedAt: new Date(Date.now() - 1_000).toISOString(),
    })
    rememberIdentityProfile('main', signed)

    const { handleDevicePeerRequest } = await import('./devicePeerHandler')
    const route = '/handcash-device/v1/identities'
    // Unauthenticated caller gets 401
    const unauth = await handleDevicePeerRequest({ method: 'GET', path: route, headers: {}, body: '', request_id: 1 })
    expect(unauth.status).toBe(401)

    // Authenticated peer gets sealed bundle
    const proof = await createDeviceAuth(rootKeyHex, 'GET', route)
    const ok = await handleDevicePeerRequest({
      method: 'GET',
      path: route,
      headers: { [DEVICE_PEER_AUTH_HEADER]: proof.header },
      body: '',
      request_id: 2,
    })
    expect(ok.status).toBe(200)
    expect(ok.body).not.toContain('Peer Issuer')
    const { sealed } = JSON.parse(ok.body) as { sealed: string }
    const opened = await openFromPeer<{ profiles: Array<{ name: string }> }>(rootKeyHex, proof.nonce, sealed)
    expect(opened.profiles[0]?.name).toBe('Peer Issuer')
  })

  it('answers and ingests identity-sync frames over vaultLink', async () => {
    const signed = await signIdentityProfile({
      master: issuerKey,
      fields: { name: 'VaultLink Issuer', description: 'Synced over WebRTC' },
      issuedAt: new Date(Date.now() - 1_000).toISOString(),
    })
    rememberIdentityProfile('main', signed)
    startVaultLinkIdentitySync()

    // Ask peer over vaultLink
    const sent = await requestIdentitiesOverVaultLink({
      chain: 'main',
      devices: ['peer-phone'],
      identityKeys: [issuerPub],
    })
    expect(sent).toBe(1)
    expect(sentFrames).toHaveLength(1)

    // Feed that request to the listener as if received from peer-phone
    const reqBody = sentFrames[0]!.body
    sentFrames.length = 0
    for (const l of linkListeners) l(reqBody, 'peer-phone')
    await new Promise((r) => setTimeout(r, 20))
    expect(sentFrames).toHaveLength(1)
    const respBody = sentFrames[0]!.body

    // Wipe local store and deliver the response to simulate receiving device
    clearStore()
    resetIdentityProfilesForTests()
    expect(identityProfileFor('main', issuerPub)).toBeNull()
    for (const l of linkListeners) l(respBody, 'peer-phone')
    await new Promise((r) => setTimeout(r, 50))
    expect(identityProfileFor('main', issuerPub)?.name).toBe('VaultLink Issuer')
  })

  it('reloads identityCard cache on card link merge and discovers open vaultLink peers via deviceMesh', async () => {
    const contactPub = PrivateKey.fromRandom().toPublicKey().toString().toLowerCase()
    const signed = await signIdentityProfile({
      master: issuerKey,
      fields: { name: 'Card Studio', description: 'Linked via card' },
      issuedAt: new Date(Date.now() - 1_000).toISOString(),
    })
    rememberIdentityProfile('main', signed)
    // Prime empty identityCard cache before merge
    expect(peerIdentityFor('main', contactPub)).toBeNull()
    const genBefore = identityCardsGeneration()

    const bundle = exportLocalIdentityBundle({ chain: 'main', accountIndex: 0, identityKey })
    bundle.cards = {
      [contactPub]: { key: issuerPub, issuedAt: new Date(Date.now() - 500).toISOString(), receivedAt: Date.now() },
    }
    const merged = await mergeRemoteIdentityBundle('main', bundle)
    expect(merged.cardsAdded).toBe(1)
    expect(identityCardsGeneration()).toBeGreaterThan(genBefore)
    const resolved = peerIdentityFor('main', contactPub)
    expect(resolved?.kind).toBe('presented')
    if (resolved?.kind === 'presented') expect(resolved.profile.name).toBe('Card Studio')

    // deviceMesh sync queries open vaultLink peers even when LAN deviceWallets list is empty
    const { syncIdentitiesFromConnectedPeers } = await import('./deviceMesh')
    sentFrames.length = 0
    await syncIdentitiesFromConnectedPeers({ identityKeys: [issuerPub] })
    expect(sentFrames.some((f) => f.device === 'peer-phone' && f.body.includes('identity-sync-request'))).toBe(true)
  })
})
