import { PrivateKey } from '@bsv/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakePeerConnection, fakeRtcFactory } from './fakeRtc.fixture'

type SessionModule = typeof import('./session')

type Install = {
  mod: SessionModule
  key: string
  device: string
  /** Signalling bodies waiting in this install's `session-upgrade` box. */
  box: string[]
  inbound: Array<{ sender: string; body: string }>
  peers: FakePeerConnection[]
}

const installs: Install[] = []

async function install(root: PrivateKey, device: string, route: (to: string, body: string) => void): Promise<Install> {
  vi.resetModules()
  const mod = await import('./session')
  const key = root.toPublicKey().toString()
  const inst: Install = { mod, key, device, box: [], inbound: [], peers: [] }
  mod.setDirectSessionIdentity({ rootKeyHex: root.toHex(), identityKey: key, device })
  mod.installRtcFactory(fakeRtcFactory(inst.peers))
  mod.installSignalSender(async (to, body) => route(to, body))
  mod.setDirectInboundHandler((sender, body) => inst.inbound.push({ sender, body }))
  installs.push(inst)
  return inst
}

/** Every install of `to` sees the body, as a shared messagebox would deliver it. */
async function network(specs: Array<{ root: PrivateKey; device: string }>): Promise<Install[]> {
  const list: Install[] = []
  const route = (to: string, body: string) => {
    for (const inst of list) if (inst.key === to) inst.box.push(body)
  }
  for (const spec of specs) list.push(await install(spec.root, spec.device, route))
  return list
}

/** Drain every box until quiet; returns each body's disposition per install. */
async function settle(list: Install[]): Promise<Map<Install, string[]>> {
  const seen = new Map<Install, string[]>(list.map(inst => [inst, []]))
  for (let round = 0; round < 10; round += 1) {
    let moved = false
    for (const inst of list) {
      const bodies = inst.box.splice(0)
      for (const body of bodies) {
        moved = true
        seen.get(inst)!.push(await inst.mod.ingestSessionSignal(body))
      }
    }
    await new Promise(r => setTimeout(r, 0))
    if (!moved) break
  }
  return seen
}

afterEach(() => {
  for (const inst of installs.splice(0)) inst.mod.resetDirectSessions()
})

describe('BRC-246 v2 sessions', () => {
  it('connects two identities through one offer and one answer, then delivers direct with an ack', async () => {
    const [mac, phone] = await network([
      { root: PrivateKey.fromRandom(), device: 'mac' },
      { root: PrivateKey.fromRandom(), device: 'phone' },
    ])
    expect(await mac!.mod.tryDirectDeliver({ recipientIdentityKey: phone!.key, body: 'early' })).toBe('box')
    expect(await mac!.mod.requestDirectSession(phone!.key)).toBe(true)
    await settle([mac!, phone!])
    expect(mac!.mod.hasDirectSession(phone!.key)).toBe(true)
    expect(phone!.mod.hasDirectSession(mac!.key)).toBe(true)
    expect(await mac!.mod.tryDirectDeliver({ recipientIdentityKey: phone!.key, body: 'sealed body' })).toBe('direct')
    expect(phone!.inbound).toEqual([{ sender: mac!.key, body: 'sealed body' }])
    expect(await phone!.mod.tryDirectDeliver({ recipientIdentityKey: mac!.key, body: 'reply' })).toBe('direct')
    expect(mac!.inbound).toEqual([{ sender: phone!.key, body: 'reply' }])
  })

  it('falls back to the box and drops the session when a frame is not acked', async () => {
    const [mac, phone] = await network([
      { root: PrivateKey.fromRandom(), device: 'mac' },
      { root: PrivateKey.fromRandom(), device: 'phone' },
    ])
    await mac!.mod.requestDirectSession(phone!.key)
    await settle([mac!, phone!])
    mac!.peers[0]!.channel.mute = true
    expect(await mac!.mod.tryDirectDeliver({ recipientIdentityKey: phone!.key, body: 'lost' })).toBe('box')
    expect(mac!.mod.hasDirectSession(phone!.key)).toBe(false)
  })

  it('keeps a body over the size cap on the box', async () => {
    const [mac, phone] = await network([
      { root: PrivateKey.fromRandom(), device: 'mac' },
      { root: PrivateKey.fromRandom(), device: 'phone' },
    ])
    await mac!.mod.requestDirectSession(phone!.key)
    await settle([mac!, phone!])
    expect(await mac!.mod.tryDirectDeliver({ recipientIdentityKey: phone!.key, body: 'x'.repeat(300_000) })).toBe('box')
    expect(mac!.mod.hasDirectSession(phone!.key)).toBe(true)
  })

  it('joins two installs of one account by device and leaves other devices\u2019 signals unacknowledged', async () => {
    const root = PrivateKey.fromRandom()
    const [mac, phone, tablet] = await network([
      { root, device: 'mac' },
      { root, device: 'phone' },
      { root, device: 'tablet' },
    ])
    expect(await mac!.mod.requestDirectSession(mac!.key)).toBe(false)
    expect(await mac!.mod.requestDirectSession(mac!.key, 'phone')).toBe(true)
    const seen = await settle([mac!, phone!, tablet!])
    expect(mac!.mod.hasDirectSession(mac!.key, 'phone')).toBe(true)
    expect(phone!.mod.hasDirectSession(mac!.key, 'mac')).toBe(true)
    expect(tablet!.mod.hasDirectSession(mac!.key)).toBe(false)
    expect(seen.get(tablet!)).toEqual(['not-mine', 'not-mine'])
    expect(seen.get(mac!)).toContain('not-mine')
    expect(await mac!.mod.tryDirectDeliver({ recipientIdentityKey: mac!.key, recipientDevice: 'phone', body: 'release-request' })).toBe('direct')
    expect(phone!.inbound).toEqual([{ sender: mac!.key, body: 'release-request' }])
  })

  it('resolves simultaneous offers to one session', async () => {
    const [mac, phone] = await network([
      { root: PrivateKey.fromRandom(), device: 'mac' },
      { root: PrivateKey.fromRandom(), device: 'phone' },
    ])
    expect(await mac!.mod.requestDirectSession(phone!.key)).toBe(true)
    expect(await phone!.mod.requestDirectSession(mac!.key)).toBe(true)
    await settle([mac!, phone!])
    expect(mac!.mod.hasDirectSession(phone!.key)).toBe(true)
    expect(phone!.mod.hasDirectSession(mac!.key)).toBe(true)
    expect(mac!.mod.hasPendingSessionOffers() || phone!.mod.hasPendingSessionOffers()).toBe(false)
    expect(await mac!.mod.tryDirectDeliver({ recipientIdentityKey: phone!.key, body: 'one' })).toBe('direct')
  })

  it('does not answer an offer its policy refuses', async () => {
    const [mac, phone] = await network([
      { root: PrivateKey.fromRandom(), device: 'mac' },
      { root: PrivateKey.fromRandom(), device: 'phone' },
    ])
    phone!.mod.installOfferPolicy(() => false)
    await mac!.mod.requestDirectSession(phone!.key)
    const seen = await settle([mac!, phone!])
    expect(seen.get(phone!)).toEqual(['handled'])
    expect(mac!.box).toEqual([])
    expect(mac!.mod.hasDirectSession(phone!.key)).toBe(false)
  })

  it('refuses an answer signed by anyone but the offered identity', async () => {
    const [mac, phone] = await network([
      { root: PrivateKey.fromRandom(), device: 'mac' },
      { root: PrivateKey.fromRandom(), device: 'phone' },
    ])
    await mac!.mod.requestDirectSession(phone!.key)
    const offer = JSON.parse(phone!.box[0]!) as { nonce: string; expiresAt: number }
    const { signSessionSignal, encodeSessionSignal } = await import('./protocol')
    const { fakeSdp } = await import('./fakeRtc.fixture')
    const forged = signSessionSignal({
      rootKeyHex: PrivateKey.fromRandom().toHex(), t: 'answer', fromDevice: 'phone', to: mac!.key, toDevice: 'mac',
      offerNonce: offer.nonce, sdp: fakeSdp(Array.from({ length: 32 }, () => 'CC').join(':')), expiresAt: offer.expiresAt,
    })
    expect(await mac!.mod.ingestSessionSignal(encodeSessionSignal({ ...forged, from: phone!.key }))).toBe('invalid')
    expect(mac!.mod.hasDirectSession(phone!.key)).toBe(false)
  })
})
