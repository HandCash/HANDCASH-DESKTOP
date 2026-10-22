import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stateToAttr } from '@aeon-ui/core'
import { CALL_RING_MS } from '../../machines/callMachine'
import type { CallRecord } from './callHistory'
import { createCallEngine, type CallEngine, type CallEngineDeps } from './callEngine'
import { encodeCallFrame } from './callWire'
import { FakeStream, fakeGetUserMedia, fakeMediaRtc, type FakeMediaConnection } from './fakeMedia.fixture'

const ALICE = '02' + 'a'.repeat(64)
const BOB = '03' + 'b'.repeat(64)
const CAROL = '02' + 'c'.repeat(64)

type Phone = {
  id: string
  engine: CallEngine
  records: CallRecord[]
  rings: (string | null)[]
  made: FakeStream[]
  pcs: FakeMediaConnection[]
  online: boolean
}

const phones = new Map<string, Phone>()

function phone(id: string, opts: Partial<CallEngineDeps> & { friends?: string[]; refuse?: string } = {}): Phone {
  const made: FakeStream[] = []
  const pcs: FakeMediaConnection[] = []
  const p: Phone = { id, records: [], rings: [], made, pcs, online: true, engine: null as unknown as CallEngine }
  const friends = new Set(opts.friends ?? [ALICE, BOB, CAROL].filter((k) => k !== id))
  p.engine = createCallEngine({
    connect: async (peer) => !!phones.get(peer)?.online,
    send: async (peer, body) => {
      const other = phones.get(peer)
      if (!other?.online) return 'box'
      setTimeout(() => other.engine.ingest(id, body), 0)
      return 'direct'
    },
    rtc: () => fakeMediaRtc(pcs),
    iceServers: () => [],
    getUserMedia: fakeGetUserMedia({ refuse: opts.refuse, made }),
    mayRing: (peer) => friends.has(peer),
    record: (r) => p.records.push(r),
    ring: (kind) => {
      if ((p.rings.at(-1) ?? null) !== kind) p.rings.push(kind)
    },
    now: () => Date.now(),
    log: () => undefined,
    ...opts,
  })
  phones.set(id, p)
  return p
}

function state(p: Phone): string {
  return stateToAttr(p.engine.getSnapshot().value)
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await vi.advanceTimersByTimeAsync(1)
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  for (const p of phones.values()) p.engine.stop()
  phones.clear()
  vi.useRealTimers()
})

describe('one-to-one voice calls', () => {
  it('rings, connects both ways, mutes, and records a finished call on both sides', async () => {
    const alice = phone(ALICE)
    const bob = phone(BOB)
    expect(alice.engine.call(BOB)).toBe(true)
    await flush()
    expect(state(alice)).toBe('outgoing:ringing')
    expect(state(bob)).toBe('incoming')
    expect(bob.rings).toContain('ring')
    expect(alice.rings).toContain('ringback')

    await bob.engine.accept()
    await flush()
    await flush()
    expect(state(alice)).toBe('active')
    expect(state(bob)).toBe('active')
    expect(alice.rings.at(-1)).toBeNull()
    expect(bob.rings.at(-1)).toBeNull()

    const aliceMic = alice.made[0]!.getAudioTracks()[0]!
    const bobMic = bob.made[0]!.getAudioTracks()[0]!
    expect(bob.engine.remoteStream()?.getTracks()).toContain(aliceMic)
    expect(alice.engine.remoteStream()?.getTracks()).toContain(bobMic)

    alice.engine.toggleMute()
    await flush()
    expect(aliceMic.enabled).toBe(false)
    expect(bob.engine.getSnapshot().context.remoteMuted).toBe(true)

    await vi.advanceTimersByTimeAsync(65_000)
    alice.engine.hangUp()
    await flush()
    expect(alice.records).toHaveLength(1)
    expect(bob.records).toHaveLength(1)
    expect(alice.records[0]).toMatchObject({ outcome: 'finished', direction: 'out', peers: [BOB] })
    expect(bob.records[0]).toMatchObject({ outcome: 'finished', direction: 'in', peers: [ALICE] })
    const r = alice.records[0]!
    expect(r.endedAt - r.connectedAt!).toBeGreaterThanOrEqual(65_000)
    expect(aliceMic.readyState).toBe('ended')
    expect(bobMic.readyState).toBe('ended')
    expect(alice.pcs[0]!.closed && bob.pcs[0]!.closed).toBe(true)
  })

  it('the callee opens no microphone until it accepts', async () => {
    const alice = phone(ALICE)
    const bob = phone(BOB)
    alice.engine.call(BOB)
    await flush()
    expect(bob.made).toHaveLength(0)
    expect(bob.pcs).toHaveLength(0)
  })

  it('a decline ends both sides as declined', async () => {
    const alice = phone(ALICE)
    const bob = phone(BOB)
    alice.engine.call(BOB)
    await flush()
    bob.engine.decline()
    await flush()
    expect(alice.records[0]).toMatchObject({ outcome: 'declined', direction: 'out' })
    expect(bob.records[0]).toMatchObject({ outcome: 'declined', direction: 'in' })
    expect(state(alice)).toBe('ended')
  })

  it('an unanswered call is no answer for the caller and missed for the callee', async () => {
    const alice = phone(ALICE)
    const bob = phone(BOB)
    alice.engine.call(BOB)
    await flush()
    await vi.advanceTimersByTimeAsync(CALL_RING_MS + 10)
    expect(alice.records[0]?.outcome).toBe('no-answer')
    expect(bob.records[0]?.outcome).toBe('missed')
    expect(bob.rings.at(-1)).toBeNull()
  })

  it('a caller hanging up while it rings leaves a missed call', async () => {
    const alice = phone(ALICE)
    const bob = phone(BOB)
    alice.engine.call(BOB)
    await flush()
    alice.engine.hangUp()
    await flush()
    expect(alice.records[0]?.outcome).toBe('cancelled')
    expect(bob.records[0]?.outcome).toBe('missed')
    expect(state(bob)).toBe('ended')
  })

  it('a second caller hears busy and the callee sees a missed call', async () => {
    const alice = phone(ALICE)
    const bob = phone(BOB)
    const carol = phone(CAROL)
    alice.engine.call(BOB)
    await flush()
    await bob.engine.accept()
    await flush()
    carol.engine.call(BOB)
    await flush()
    await flush()
    expect(carol.records[0]?.outcome).toBe('busy')
    expect(bob.records[0]).toMatchObject({ outcome: 'missed', peers: [CAROL] })
    expect(state(bob)).toBe('active')
  })

  it('an offline friend is unreachable, and nothing rings', async () => {
    const alice = phone(ALICE)
    const bob = phone(BOB)
    bob.online = false
    alice.engine.call(BOB)
    await flush()
    expect(alice.records[0]?.outcome).toBe('unreachable')
    expect(bob.rings).toHaveLength(0)
    expect(alice.made[0]!.getAudioTracks()[0]!.readyState).toBe('ended')
  })

  it('a refused microphone fails the call with the reason', async () => {
    const alice = phone(ALICE, { refuse: 'NotAllowedError' } as never)
    phone(BOB)
    alice.engine.call(BOB)
    await flush()
    expect(state(alice)).toBe('ended')
    expect(alice.engine.getSnapshot().context.failure).toMatch(/microphone/)
    expect(alice.records[0]?.outcome).toBe('failed')
  })

  it('a dropped connection ends the call as failed', async () => {
    const alice = phone(ALICE)
    const bob = phone(BOB)
    alice.engine.call(BOB)
    await flush()
    await bob.engine.accept()
    await flush()
    alice.pcs[0]!.fail()
    await flush()
    expect(alice.records[0]?.outcome).toBe('failed')
    expect(bob.records[0]?.outcome).toBe('failed')
  })

  it('ignores calls from anyone who is not a friend', async () => {
    const alice = phone(ALICE)
    const bob = phone(BOB, { friends: [] } as never)
    alice.engine.call(BOB)
    await flush()
    expect(state(bob)).toBe('idle')
    expect(bob.rings).toHaveLength(0)
  })

  it('ignores frames for another call or from another identity', async () => {
    const alice = phone(ALICE)
    const bob = phone(BOB)
    alice.engine.call(BOB)
    await flush()
    const callId = bob.engine.getSnapshot().context.callId!
    expect(bob.engine.ingest(CAROL, encodeCallFrame({ t: 'hangup', call: callId, reason: 'hung-up' }))).toBe(true)
    expect(state(bob)).toBe('incoming')
    expect(bob.engine.ingest(ALICE, 'not a call frame')).toBe(false)
  })

  it('two friends calling each other at once end up on one call', async () => {
    const alice = phone(ALICE)
    const bob = phone(BOB)
    alice.engine.call(BOB)
    bob.engine.call(ALICE)
    await flush()
    await flush()
    await flush()
    expect(state(alice)).toBe('active')
    expect(state(bob)).toBe('active')
    expect(alice.engine.getSnapshot().context.callId).toBe(bob.engine.getSnapshot().context.callId)
    expect([...alice.records, ...bob.records]).toHaveLength(0)
  })

  it('ending everything on lock hangs up the far side too', async () => {
    const alice = phone(ALICE)
    const bob = phone(BOB)
    alice.engine.call(BOB)
    await flush()
    await bob.engine.accept()
    await flush()
    bob.engine.endAll()
    await flush()
    expect(alice.records[0]?.outcome).toBe('finished')
    expect(state(alice)).toBe('ended')
  })
})
