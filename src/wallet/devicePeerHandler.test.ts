import { PrivateKey } from '@bsv/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEVICE_PEER_AUTH_HEADER, createDeviceAuth, openFromPeer } from './devicePeerAuth'

const root = PrivateKey.fromRandom()
const rootKeyHex = root.toHex()
const identityKey = root.toPublicKey().toString()
const stranger = PrivateKey.fromRandom().toHex()

vi.mock('./session', () => ({
  getActiveWallet: () => ({ identityKey, address: '1LocalAddress', rootKeyHex, wallet: {} }),
  fetchBalanceSats: async () => 123_456,
}))
vi.mock('./friends', () => ({ listFriends: () => [{ handle: 'alice' }] }))
vi.mock('./collectables', () => ({ listCollectables: async () => [] }))
vi.mock('./deviceWallets', () => ({
  enrollLocalDevice: (args: { identityKey: string; platform: string }) => ({
    ...args,
    deviceId: 'desk-1',
    label: 'Desk',
  }),
  buildPairPayload: (args: object) => ({ v: 3, ...args, deviceId: 'desk-1' }),
  getOrCreateDeviceId: () => 'desk-1',
}))
vi.mock('./scanLogin/receiver', () => ({
  isScanLoginPath: () => false,
  handleScanLoginRequest: vi.fn(),
}))

const SNAPSHOT = '/handcash-device/v1/snapshot'
const HEALTH = '/handcash-device/v1/health'
let nextId = 1

function request(path: string, headers: Record<string, string> = {}) {
  return { method: 'GET', path, headers, body: '', request_id: nextId++ }
}

async function signed(path: string, key = rootKeyHex, now?: number) {
  const proof = await createDeviceAuth(key, 'GET', path, now)
  return { proof, event: request(path, { [DEVICE_PEER_AUTH_HEADER]: proof.header }) }
}

describe('device-peer requests', { timeout: 30_000 }, () => {
  beforeEach(() => {
    vi.stubGlobal('window', { handcash: { platform: 'darwin' } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('gives a caller with no proof nothing, even when it names the identity key', async () => {
    const { handleDevicePeerRequest } = await import('./devicePeerHandler')
    for (const path of [HEALTH, SNAPSHOT, '/handcash-device/v1/pair-info']) {
      const res = await handleDevicePeerRequest(request(path, { 'x-handcash-identity': identityKey }))
      expect(res.status).toBe(401)
      expect(res.body).not.toContain(identityKey)
      expect(res.body).not.toContain('123456')
      expect(res.body).not.toContain('alice')
    }
  })

  it('refuses a proof made with another wallet', async () => {
    const { handleDevicePeerRequest } = await import('./devicePeerHandler')
    const { event } = await signed(SNAPSHOT, stranger)
    const res = await handleDevicePeerRequest(event)
    expect(res.status).toBe(401)
    expect(res.body).not.toContain(identityKey)
  })

  it('refuses a replayed, stale or re-aimed proof', async () => {
    const { handleDevicePeerRequest } = await import('./devicePeerHandler')
    const { event } = await signed(SNAPSHOT)
    expect((await handleDevicePeerRequest(event)).status).toBe(200)
    expect((await handleDevicePeerRequest({ ...event, request_id: nextId++ })).status).toBe(401)

    const stale = await signed(SNAPSHOT, rootKeyHex, Date.now() - 120_000)
    expect((await handleDevicePeerRequest(stale.event)).status).toBe(401)

    const aimed = await signed(HEALTH)
    expect((await handleDevicePeerRequest({ ...aimed.event, path: SNAPSHOT })).status).toBe(401)
  })

  it('seals the snapshot so only the same wallet can read it', async () => {
    const { handleDevicePeerRequest } = await import('./devicePeerHandler')
    const { proof, event } = await signed(SNAPSHOT)
    const res = await handleDevicePeerRequest(event)
    expect(res.status).toBe(200)
    expect(res.body).not.toContain(identityKey)
    const { sealed } = JSON.parse(res.body) as { sealed: string }
    const snapshot = await openFromPeer<{ identityKey: string; balanceSats: number }>(rootKeyHex, proof.nonce, sealed)
    expect(snapshot).toMatchObject({ identityKey, balanceSats: 123_456 })
    await expect(openFromPeer(stranger, proof.nonce, sealed)).rejects.toThrow()
  })

  it('still lets a device signed in to the same wallet probe and sync', async () => {
    const { handleDevicePeerRequest } = await import('./devicePeerHandler')
    vi.stubGlobal('fetch', async (url: string, init: { headers: Record<string, string> }) => {
      const res = await handleDevicePeerRequest(request(new URL(url).pathname, init.headers))
      return new Response(res.body, { status: res.status })
    })
    const { fetchDevicePeerSnapshot, probeDevicePeer } = await import('./devicePeer')
    expect(await probeDevicePeer('http://192.168.1.20:3340', rootKeyHex)).toMatchObject({ identityKey, deviceId: 'desk-1' })
    expect(await probeDevicePeer('http://192.168.1.20:3340', stranger)).toBeNull()
    const snap = await fetchDevicePeerSnapshot('http://192.168.1.20:3340', identityKey, rootKeyHex)
    expect(snap.friends).toEqual([{ handle: 'alice' }])
  })
})
