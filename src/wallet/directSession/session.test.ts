import { PrivateKey } from '@bsv/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeRtc, type FakePeerConnection } from './fakeRtc.fixture'

type SessionModule = typeof import('./session')

type Install = {
  mod: SessionModule
  key: string
  device: string
  /** Signals waiting in this install's `webrtpay_messages` box, with the carrier's sender. */
  box: Array<{ sender: string; body: string }>
  inbound: Array<{ sender: string; body: string; device: string }>
  peers: FakePeerConnection[]
}

const installs: Install[] = []

async function install(
  spec: { root: PrivateKey; device: string; chain?: string },
  route: (from: string, to: string, body: string) => void,
): Promise<Install> {
  vi.resetModules()
  const mod = await import('./session')
  const key = spec.root.toPublicKey().toString()
  const inst: Install = { mod, key, device: spec.device, box: [], inbound: [], peers: [] }
  mod.setDirectSessionIdentity({ rootKeyHex: spec.root.toHex(), identityKey: key, device: spec.device, chain: spec.chain ?? 'main' })
  mod.installRtc(fakeRtc(inst.peers))
  mod.installSignalSender(async (to, body) => route(key, to, body))
  mod.installOfferPolicy(() => true)
  mod.setDirectInboundHandler((sender, body, device) => inst.inbound.push({ sender, body, device }))
  installs.push(inst)
  return inst
}

/** Every install of `to` sees the signal, as a shared messagebox would list it. */
async function network(specs: Array<{ root: PrivateKey; device: string; chain?: string }>): Promise<Install[]> {
  const list: Install[] = []
  const route = (from: string, to: string, body: string) => {
    for (const inst of list) if (inst.key === to) inst.box.push({ sender: from, body })
  }
  for (const spec of specs) list.push(await install(spec, route))
  return list
}

const tick = () => new Promise((r) => setTimeout(r, 0))

/** Drain every box until quiet; returns each signal's disposition per install. */
async function settle(list: Install[]): Promise<Map<Install, string[]>> {
  const seen = new Map<Install, string[]>(list.map((inst) => [inst, []]))
  for (let round = 0; round < 20; round += 1) {
    let moved = false
    for (const inst of list) {
      for (const signal of inst.box.splice(0)) {
        moved = true
        seen.get(inst)!.push(await inst.mod.ingestSessionSignal(signal.sender, signal.body))
      }
    }
    for (let i = 0; i < 5; i += 1) await tick()
    if (!moved && list.every((inst) => inst.box.length === 0)) break
  }
  return seen
}

afterEach(() => {
  vi.useRealTimers()
  for (const inst of installs.splice(0)) inst.mod.resetDirectSessions()
})

function two(chains: [string, string] = ['main', 'main']) {
  return network([
    { root: PrivateKey.fromRandom(), device: 'mac', chain: chains[0] },
    { root: PrivateKey.fromRandom(), device: 'phone', chain: chains[1] },
  ])
}

describe('draft BRC-246 sessions over webrtpay/1', () => {
  it('connects through knock, ring, offer and answer, then delivers direct with an ack', async () => {
    const [mac, phone] = await two()
    expect(await mac!.mod.tryDirectDeliver({ recipientIdentityKey: phone!.key, body: 'early' })).toBe('box')
    expect(await mac!.mod.requestDirectSession(phone!.key)).toBe(true)
    expect(Object.keys(JSON.parse(phone!.box[0]!.body)).sort()).toEqual(['ciphertext', 'sid', 'v'])
    expect(mac!.peers).toHaveLength(1)
    await settle([mac!, phone!])
    expect(mac!.mod.hasDirectSession(phone!.key)).toBe(true)
    expect(phone!.mod.hasDirectSession(mac!.key)).toBe(true)
    expect(mac!.mod.hasActiveSessionDials()).toBe(false)
    expect(await mac!.mod.tryDirectDeliver({ recipientIdentityKey: phone!.key, body: 'sealed body' })).toBe('direct')
    expect(phone!.inbound).toEqual([{ sender: mac!.key, body: 'sealed body', device: 'mac' }])
    expect(await phone!.mod.tryDirectDeliver({ recipientIdentityKey: mac!.key, body: 'reply' })).toBe('direct')
    expect(mac!.inbound).toEqual([{ sender: phone!.key, body: 'reply', device: 'phone' }])
  })

  it('falls back to the box and drops the session when a message is not acked within a second', async () => {
    const [mac, phone] = await two()
    await mac!.mod.requestDirectSession(phone!.key)
    await settle([mac!, phone!])
    mac!.peers[0]!.channel!.mute = true
    const started = Date.now()
    expect(await mac!.mod.tryDirectDeliver({ recipientIdentityKey: phone!.key, body: 'lost' })).toBe('box')
    expect(Date.now() - started).toBeGreaterThanOrEqual(mac!.mod.SESSION_ACK_MS - 5)
    expect(mac!.mod.hasDirectSession(phone!.key)).toBe(false)
    expect(phone!.inbound).toEqual([])
  })

  it('keeps a body over 256 KiB on the box and the session open', async () => {
    const [mac, phone] = await two()
    await mac!.mod.requestDirectSession(phone!.key)
    await settle([mac!, phone!])
    expect(await mac!.mod.tryDirectDeliver({ recipientIdentityKey: phone!.key, body: 'x'.repeat(300_000) })).toBe('box')
    expect(mac!.mod.hasDirectSession(phone!.key)).toBe(true)
  })

  it('routes installs of one account by device and leaves other devices\u2019 signals unacknowledged', async () => {
    const root = PrivateKey.fromRandom()
    const [mac, phone, tablet] = await network([
      { root, device: 'mac' },
      { root, device: 'phone' },
      { root, device: 'tablet' },
    ])
    expect(await mac!.mod.requestDirectSession(mac!.key)).toBe(false)
    expect(await mac!.mod.requestDirectSession(mac!.key, 'mac')).toBe(false)
    expect(await mac!.mod.requestDirectSession(mac!.key, 'phone')).toBe(true)
    const seen = await settle([mac!, phone!, tablet!])
    expect(mac!.mod.hasDirectSession(mac!.key, 'phone')).toBe(true)
    expect(phone!.mod.hasDirectSession(mac!.key, 'mac')).toBe(true)
    expect(tablet!.mod.hasDirectSession(mac!.key)).toBe(false)
    expect(tablet!.peers).toHaveLength(0)
    expect(seen.get(tablet!)).toEqual(['not-mine', 'not-mine', 'not-mine', 'not-mine'])
    expect(seen.get(mac!)!.filter((d) => d === 'not-mine')).toHaveLength(2)
    expect(seen.get(phone!)!.filter((d) => d === 'not-mine')).toHaveLength(2)
    expect(await mac!.mod.tryDirectDeliver({ recipientIdentityKey: mac!.key, recipientDevice: 'phone', body: 'release-request' })).toBe('direct')
    expect(phone!.inbound).toEqual([{ sender: mac!.key, body: 'release-request', device: 'mac' }])
    expect(await mac!.mod.tryDirectDeliver({ recipientIdentityKey: mac!.key, recipientDevice: 'tablet', body: 'x' })).toBe('box')
  })

  it('names the answering install when the dial named none', async () => {
    const [mac, phone] = await two()
    await mac!.mod.requestDirectSession(phone!.key)
    await settle([mac!, phone!])
    expect(mac!.mod.hasDirectSession(phone!.key, 'phone')).toBe(true)
    expect(mac!.mod.hasDirectSession(phone!.key, 'tablet')).toBe(false)
  })

  it('reads at the dialling cadence after ringing a knock, until its offer arrives', async () => {
    const [mac, phone] = await two()
    await mac!.mod.requestDirectSession(phone!.key)
    for (const s of phone!.box.splice(0)) await phone!.mod.ingestSessionSignal(s.sender, s.body)
    expect(phone!.mod.hasActiveSessionDials()).toBe(true)
    await settle([mac!, phone!])
    expect(phone!.mod.hasDirectSession(mac!.key)).toBe(true)
    expect(phone!.mod.hasActiveSessionDials()).toBe(false)
  })

  it('lets a dial wait longer for its ring when asked', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const [mac, phone] = await two()
    const [, tablet] = await two()
    expect(await mac!.mod.requestDirectSession(phone!.key)).toBe(true)
    expect(await tablet!.mod.requestDirectSession(phone!.key, '', Date.now(), 30_000)).toBe(true)
    vi.advanceTimersByTime(mac!.mod.SESSION_PRESENCE_MS + 100)
    expect(mac!.mod.hasActiveSessionDials()).toBe(false)
    expect(tablet!.mod.hasActiveSessionDials()).toBe(true)
    vi.advanceTimersByTime(30_000)
    expect(tablet!.mod.hasActiveSessionDials()).toBe(false)
  })

  it('resolves simultaneous dials to one session', async () => {
    const [mac, phone] = await two()
    expect(await mac!.mod.requestDirectSession(phone!.key)).toBe(true)
    expect(await phone!.mod.requestDirectSession(mac!.key)).toBe(true)
    await settle([mac!, phone!])
    expect(mac!.mod.hasDirectSession(phone!.key)).toBe(true)
    expect(phone!.mod.hasDirectSession(mac!.key)).toBe(true)
    expect(mac!.mod.hasActiveSessionDials() || phone!.mod.hasActiveSessionDials()).toBe(false)
    expect(mac!.peers.filter((pc) => !pc.closed).length + phone!.peers.filter((pc) => !pc.closed).length).toBe(2)
    expect(await mac!.mod.tryDirectDeliver({ recipientIdentityKey: phone!.key, body: 'one' })).toBe('direct')
  })

  it('neither rings nor answers an identity its policy refuses', async () => {
    const [mac, phone] = await two()
    phone!.mod.installOfferPolicy(() => false)
    await mac!.mod.requestDirectSession(phone!.key)
    const seen = await settle([mac!, phone!])
    expect(seen.get(phone!)).toEqual(['handled'])
    expect(mac!.box).toEqual([])
    expect(phone!.peers).toHaveLength(0)
    expect(mac!.mod.hasDirectSession(phone!.key)).toBe(false)
  })

  it('refuses a dial from another network with reject wrong_network', async () => {
    const [mac, phone] = await two(['main', 'test'])
    await mac!.mod.requestDirectSession(phone!.key)
    const seen = await settle([mac!, phone!])
    expect(seen.get(mac!)).toEqual(['handled'])
    expect(mac!.mod.hasActiveSessionDials()).toBe(false)
    expect(phone!.peers).toHaveLength(0)
  })

  it('refuses a reply whose carrier sender is not the dialled identity, and a replayed knock', async () => {
    const [mac, phone] = await two()
    await mac!.mod.requestDirectSession(phone!.key)
    const knock = phone!.box[0]!
    await settle([phone!])
    const ring = mac!.box.shift()!
    const stranger = PrivateKey.fromRandom().toPublicKey().toString()
    expect(await mac!.mod.ingestSessionSignal(stranger, ring.body)).toBe('invalid')
    expect(await phone!.mod.ingestSessionSignal(knock.sender, knock.body)).toBe('invalid')
    expect(await mac!.mod.ingestSessionSignal(ring.sender, ring.body)).toBe('handled')
  })

  it('gives up a dial nobody rings within the presence window, and does not redial at once', async () => {
    const [mac, phone] = await two()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    expect(await mac!.mod.requestDirectSession(phone!.key)).toBe(true)
    expect(mac!.mod.hasActiveSessionDials()).toBe(true)
    await vi.advanceTimersByTimeAsync(mac!.mod.SESSION_PRESENCE_MS + 1)
    expect(mac!.mod.hasActiveSessionDials()).toBe(false)
    expect(mac!.peers.every((pc) => pc.closed)).toBe(true)
    expect(await mac!.mod.requestDirectSession(phone!.key)).toBe(false)
  })

  it('ends both sides with bye on reset (lock or account switch)', async () => {
    const [mac, phone] = await two()
    await mac!.mod.requestDirectSession(phone!.key)
    await settle([mac!, phone!])
    mac!.mod.resetDirectSessions()
    expect(mac!.mod.hasDirectSession(phone!.key)).toBe(false)
    await vi.waitFor(() => expect(phone!.mod.hasDirectSession(mac!.key)).toBe(false))
  })

  it('closes a session idle for ten minutes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    const [mac, phone] = await two()
    await mac!.mod.requestDirectSession(phone!.key)
    await settle([mac!, phone!])
    expect(mac!.mod.hasDirectSession(phone!.key)).toBe(true)
    await vi.advanceTimersByTimeAsync(mac!.mod.SESSION_IDLE_MS - 60_000)
    expect(await mac!.mod.tryDirectDeliver({ recipientIdentityKey: phone!.key, body: 'keeps it warm' })).toBe('direct')
    await vi.advanceTimersByTimeAsync(mac!.mod.SESSION_IDLE_MS - 60_000)
    expect(mac!.mod.hasDirectSession(phone!.key)).toBe(true)
    await vi.advanceTimersByTimeAsync(60_001)
    expect(mac!.mod.hasDirectSession(phone!.key)).toBe(false)
    expect(phone!.mod.hasDirectSession(mac!.key)).toBe(false)
  })
})
