import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stateToAttr } from '@aeon-ui/core'
import { CALL_RING_MS } from '../../machines/callMachine'
import type { CallRecord } from './callHistory'
import { createCallEngine, type CallEngine, type CallEngineDeps } from './callEngine'
import { encodeCallFrame } from './callWire'
import { FakeStream, FakeTrack, fakeGetUserMedia, fakeMediaRtc, type FakeMediaConnection } from './fakeMedia.fixture'

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
/** Taken before fake timers go in: WebCrypto settles on the real event loop. */
const realTimeout = globalThis.setTimeout

function phone(id: string, opts: Partial<CallEngineDeps> & { friends?: string[]; refuse?: string; refuseVideo?: string } = {}): Phone {
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
    getUserMedia: fakeGetUserMedia({ refuse: opts.refuse, refuseVideo: opts.refuseVideo, made }),
    mayRing: (peer) => friends.has(peer),
    record: (r) => p.records.push(r),
    ring: (kind) => {
      if ((p.rings.at(-1) ?? null) !== kind) p.rings.push(kind)
    },
    now: () => Date.now(),
    log: () => undefined,
    self: () => id,
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

function tracks(p: Phone, kind: 'audio' | 'video') {
  return p.made.flatMap((s) => (kind === 'audio' ? s.getAudioTracks() : s.getVideoTracks()))
}

async function connectVideo(alice: Phone, bob: Phone, answer: { video?: boolean } = {}) {
  alice.engine.call(BOB, { video: true })
  await flush()
  await bob.engine.accept(answer)
  await flush()
  await flush()
}

describe('video calls', () => {
  it('a video call sends both cameras, and each side knows the other\u2019s is on', async () => {
    const alice = phone(ALICE)
    const bob = phone(BOB)
    await connectVideo(alice, bob)
    expect(state(alice)).toBe('active')
    expect(bob.engine.getSnapshot().context).toMatchObject({ video: true, camera: true, remoteCamera: true })
    expect(alice.engine.getSnapshot().context).toMatchObject({ camera: true, remoteCamera: true })
    const aliceCam = tracks(alice, 'video')[0]!
    const bobCam = tracks(bob, 'video')[0]!
    expect(bob.engine.remoteStream()?.getVideoTracks()).toContain(aliceCam)
    expect(alice.engine.remoteStream()?.getVideoTracks()).toContain(bobCam)
  })

  it('answering without video keeps the callee\u2019s camera closed', async () => {
    const alice = phone(ALICE)
    const bob = phone(BOB)
    await connectVideo(alice, bob, { video: false })
    expect(tracks(bob, 'video')).toHaveLength(0)
    expect(bob.engine.getSnapshot().context.camera).toBe(false)
    expect(alice.engine.getSnapshot().context.remoteCamera).toBe(false)
    expect(bob.engine.getSnapshot().context.remoteCamera).toBe(true)
  })

  it('turning the camera off releases it and tells the far side; on again sends a fresh one', async () => {
    const alice = phone(ALICE)
    const bob = phone(BOB)
    await connectVideo(alice, bob)
    const first = tracks(alice, 'video')[0]!
    await alice.engine.setCamera(false)
    await flush()
    expect(first.readyState).toBe('ended')
    expect(alice.engine.localStream()?.getVideoTracks()).toHaveLength(0)
    expect(bob.engine.getSnapshot().context.remoteCamera).toBe(false)

    await alice.engine.setCamera(true)
    await flush()
    const second = tracks(alice, 'video')[1]!
    expect(second.readyState).toBe('live')
    expect(alice.engine.localStream()?.getVideoTracks()).toEqual([second])
    expect(alice.pcs[0]!.getSenders().map((s) => s.track)).toContain(second)
    expect(bob.engine.getSnapshot().context.remoteCamera).toBe(true)
  })

  it('a voice call can turn video on mid-call, renegotiating the new track over', async () => {
    const alice = phone(ALICE)
    const bob = phone(BOB)
    alice.engine.call(BOB)
    await flush()
    await bob.engine.accept()
    await flush()
    await flush()
    await bob.engine.setCamera(true)
    await flush()
    await flush()
    const cam = tracks(bob, 'video')[0]!
    expect(alice.engine.remoteStream()?.getVideoTracks()).toContain(cam)
    expect(alice.engine.getSnapshot().context.remoteCamera).toBe(true)
    expect(state(alice)).toBe('active')
  })

  it('switching camera and microphone swaps the sent tracks in place and remembers the choice', async () => {
    const remembered: [string, string][] = []
    const alice = phone(ALICE, { rememberDevice: (kind, id) => remembered.push([kind, id]) })
    const bob = phone(BOB)
    await connectVideo(alice, bob)
    const senders = alice.pcs[0]!.getSenders()
    await alice.engine.useCamera('cam-back')
    await alice.engine.useMic('mic-usb')
    expect(alice.engine.devicesInUse()).toEqual({ mic: 'mic-usb', camera: 'cam-back' })
    expect(alice.pcs[0]!.getSenders()).toHaveLength(senders.length)
    expect(tracks(alice, 'video')[0]!.readyState).toBe('ended')
    expect(tracks(alice, 'audio')[0]!.readyState).toBe('ended')
    expect(remembered).toEqual([
      ['camera', 'cam-back'],
      ['mic', 'mic-usb'],
    ])
  })

  it('a switched microphone stays muted when the call is muted', async () => {
    const alice = phone(ALICE)
    const bob = phone(BOB)
    await connectVideo(alice, bob)
    alice.engine.toggleMute()
    await alice.engine.useMic('mic-usb')
    expect(alice.engine.localStream()?.getAudioTracks()[0]?.enabled).toBe(false)
  })

  it('a camera that will not start leaves the call going as voice and says why', async () => {
    const alice = phone(ALICE, { refuseVideo: 'NotReadableError' })
    const bob = phone(BOB)
    await connectVideo(alice, bob)
    expect(state(alice)).toBe('active')
    expect(alice.engine.getSnapshot().context.camera).toBe(false)
    expect(alice.engine.cameraProblem()).toBe('The camera is in use by another app')
    expect(bob.engine.getSnapshot().context.remoteCamera).toBe(false)
  })

  it('opens the remembered devices, preferred rather than required', async () => {
    const asked: MediaStreamConstraints[] = []
    const gum = fakeGetUserMedia()
    const alice = phone(ALICE, {
      devices: () => ({ mic: 'mic-usb', camera: 'cam-back' }),
      getUserMedia: (c) => {
        asked.push(c)
        return gum(c)
      },
    })
    phone(BOB)
    alice.engine.call(BOB, { video: true })
    await flush()
    expect(asked).toEqual([
      { audio: expect.objectContaining({ deviceId: { ideal: 'mic-usb' } }) },
      { video: expect.objectContaining({ deviceId: { ideal: 'cam-back' } }) },
    ])
  })
})

describe('screen sharing', () => {
  let screens: FakeTrack[]
  const captureScreen = async (id: string) => {
    const t = new FakeTrack('video', id)
    screens.push(t)
    return new FakeStream([t]) as unknown as MediaStream
  }
  beforeEach(() => {
    screens = []
  })

  it('sends the screen in place of the camera, and stopping brings a fresh camera back', async () => {
    const alice = phone(ALICE, { captureScreen })
    const bob = phone(BOB)
    await connectVideo(alice, bob)
    const senders = alice.pcs[0]!.getSenders().length
    const cam = tracks(alice, 'video')[0]!
    await alice.engine.shareScreen('screen:1:0')
    await flush()
    const screen = screens[0]!
    expect(cam.readyState).toBe('ended')
    expect(alice.pcs[0]!.getSenders()).toHaveLength(senders)
    expect(alice.pcs[0]!.getSenders().map((x) => x.track)).toContain(screen)
    expect(alice.engine.getSnapshot().context).toMatchObject({ sharing: true, camera: true })
    expect(alice.engine.devicesInUse().camera).toBeNull()
    expect(bob.engine.getSnapshot().context).toMatchObject({ remoteSharing: true, remoteCamera: false })

    await alice.engine.stopSharing()
    await flush()
    const fresh = tracks(alice, 'video')[1]!
    expect(screen.readyState).toBe('ended')
    expect(fresh.readyState).toBe('live')
    expect(alice.pcs[0]!.getSenders().map((x) => x.track)).toContain(fresh)
    expect(bob.engine.getSnapshot().context).toMatchObject({ remoteSharing: false, remoteCamera: true })
  })

  it('a voice call can share a window, and stopping leaves it voice again', async () => {
    const alice = phone(ALICE, { captureScreen })
    const bob = phone(BOB)
    alice.engine.call(BOB)
    await flush()
    await bob.engine.accept()
    await flush()
    await flush()
    await alice.engine.shareScreen('window:42:0')
    await flush()
    await flush()
    expect(bob.engine.remoteStream()?.getVideoTracks()).toContain(screens[0])
    expect(bob.engine.getSnapshot().context.remoteSharing).toBe(true)

    await alice.engine.stopSharing()
    await flush()
    expect(alice.engine.localStream()?.getVideoTracks()).toHaveLength(0)
    expect(alice.made.flatMap((x) => x.getVideoTracks())).toHaveLength(0)
    expect(bob.engine.getSnapshot().context).toMatchObject({ remoteSharing: false, remoteCamera: false })
    expect(state(alice)).toBe('active')
  })

  it('stopping from the system ends the share like the button does', async () => {
    const alice = phone(ALICE, { captureScreen })
    const bob = phone(BOB)
    await connectVideo(alice, bob)
    await alice.engine.shareScreen('screen:1:0')
    await flush()
    screens[0]!.end()
    await flush()
    expect(alice.engine.getSnapshot().context.sharing).toBe(false)
    expect(bob.engine.getSnapshot().context.remoteSharing).toBe(false)
    expect(alice.engine.localStream()?.getVideoTracks()[0]?.readyState).toBe('live')
  })

  it('turning the camera off while sharing keeps the share, and stopping then sends no video', async () => {
    const alice = phone(ALICE, { captureScreen })
    const bob = phone(BOB)
    await connectVideo(alice, bob)
    await alice.engine.shareScreen('screen:1:0')
    await flush()
    await alice.engine.setCamera(false)
    await flush()
    expect(screens[0]!.readyState).toBe('live')
    expect(alice.engine.getSnapshot().context).toMatchObject({ sharing: true, camera: false })
    await alice.engine.stopSharing()
    await flush()
    expect(alice.engine.localStream()?.getVideoTracks()).toHaveLength(0)
    expect(bob.engine.getSnapshot().context).toMatchObject({ remoteSharing: false, remoteCamera: false })
  })

  it('a refused share keeps the call and camera going and says why', async () => {
    const alice = phone(ALICE, {
      captureScreen: async () => {
        throw new Error('NotAllowedError')
      },
      screenFailureText: () => 'HandCash isn\u2019t allowed to record the screen',
    })
    const bob = phone(BOB)
    await connectVideo(alice, bob)
    await alice.engine.shareScreen('screen:1:0')
    await flush()
    expect(alice.engine.shareProblem()).toBe('HandCash isn\u2019t allowed to record the screen')
    expect(alice.engine.getSnapshot().context.sharing).toBe(false)
    expect(tracks(alice, 'video')[0]!.readyState).toBe('live')
    expect(state(alice)).toBe('active')
  })

  it('offers nothing to share where capture is unavailable', async () => {
    const alice = phone(ALICE)
    const bob = phone(BOB)
    await connectVideo(alice, bob)
    expect(alice.engine.canShareScreen()).toBe(false)
    await alice.engine.shareScreen('screen:1:0')
    expect(alice.engine.getSnapshot().context.sharing).toBe(false)
  })
})

function fakeE2ee(id: string, opts: { refuse?: boolean } = {}) {
  const seen = { senders: [] as unknown[], receivers: [] as unknown[], closed: 0, unreadable: null as (() => void) | null }
  const deps: NonNullable<CallEngineDeps['e2ee']> = {
    secret: async (peer, callId) => {
      if (opts.refuse) throw new Error('no account')
      const text = `${[id, peer].sort().join(' ')} ${callId}`
      return Uint8Array.from({ length: 32 }, (_, i) => text.charCodeAt(i % text.length) ^ i)
    },
    protector: (_keys, onUnreadable) => {
      seen.unreadable = onUnreadable
      return {
        config: {},
        sender: (sender) => seen.senders.push(sender),
        receiver: (receiver) => seen.receivers.push(receiver),
        close: () => {
          seen.closed += 1
        },
      }
    },
  }
  return { seen, deps }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => realTimeout(resolve, 2))
    await flush()
  }
}

describe('end-to-end media keys', () => {
  it('seals every sender and receiver under agreed keys, and both sides show the same safety code', async () => {
    const a = fakeE2ee(ALICE)
    const b = fakeE2ee(BOB)
    const alice = phone(ALICE, { e2ee: a.deps })
    const bob = phone(BOB, { e2ee: b.deps })
    alice.engine.call(BOB, { video: true })
    await settle()
    await bob.engine.accept()
    await settle()
    expect(state(alice)).toBe('active')
    const code = alice.engine.safetyCode()
    expect(code).toMatch(/^\d{4} \d{4} \d{4}$/)
    expect(bob.engine.safetyCode()).toBe(code)
    expect(alice.engine.encrypted() && bob.engine.encrypted()).toBe(true)
    expect(a.seen.senders).toEqual(alice.pcs[0]!.getSenders())
    expect(b.seen.senders).toEqual(bob.pcs[0]!.getSenders())
    expect(a.seen.senders).toHaveLength(2)
    expect(a.seen.receivers).toHaveLength(2)
    expect(b.seen.receivers).toHaveLength(2)

    alice.engine.hangUp()
    await settle()
    expect(a.seen.closed).toBe(1)
    expect(b.seen.closed).toBe(1)
    expect(alice.engine.safetyCode()).toBeNull()
  })

  it('a camera turned on mid-call is sealed too, and a shared screen rides the same sealed sender', async () => {
    const a = fakeE2ee(ALICE)
    const alice = phone(ALICE, {
      e2ee: a.deps,
      captureScreen: async () => new FakeStream([new FakeTrack('video', 'screen')]) as unknown as MediaStream,
    })
    const bob = phone(BOB, { e2ee: fakeE2ee(BOB).deps })
    alice.engine.call(BOB)
    await settle()
    await bob.engine.accept()
    await settle()
    expect(a.seen.senders).toHaveLength(1)
    await alice.engine.setCamera(true)
    await settle()
    expect(a.seen.senders).toHaveLength(2)
    await alice.engine.shareScreen('screen:1:0')
    await settle()
    expect(a.seen.senders).toHaveLength(2)
    expect(alice.pcs[0]!.getSenders()).toHaveLength(2)
  })

  it('keys that cannot be agreed end the call instead of sending in the clear', async () => {
    const alice = phone(ALICE, { e2ee: fakeE2ee(ALICE).deps })
    const bob = phone(BOB, { e2ee: fakeE2ee(BOB, { refuse: true }).deps })
    alice.engine.call(BOB)
    await settle()
    await bob.engine.accept()
    await settle()
    expect(bob.pcs).toHaveLength(0)
    expect(bob.records[0]?.outcome).toBe('failed')
    expect(state(alice)).toBe('ended')
  })

  it('says so when the far side\u2019s frames stop opening', async () => {
    const a = fakeE2ee(ALICE)
    const alice = phone(ALICE, { e2ee: a.deps })
    const bob = phone(BOB, { e2ee: fakeE2ee(BOB).deps })
    alice.engine.call(BOB)
    await settle()
    await bob.engine.accept()
    await settle()
    expect(alice.engine.e2eProblem()).toBeNull()
    a.seen.unreadable!()
    expect(alice.engine.e2eProblem()).toMatch(/can\u2019t be decrypted/)
  })
})

describe('group calls', () => {
  async function threeWay(video = false): Promise<[Phone, Phone, Phone]> {
    const alice = phone(ALICE)
    const bob = phone(BOB)
    const carol = phone(CAROL)
    alice.engine.call(BOB, { video })
    await flush()
    await bob.engine.accept()
    await flush()
    await flush()
    expect(alice.engine.invite(CAROL)).toBe(true)
    await flush()
    expect(state(carol)).toBe('incoming')
    expect(carol.engine.getSnapshot().context.members).toEqual([ALICE, BOB])
    await carol.engine.accept()
    for (let i = 0; i < 4; i += 1) await flush()
    return [alice, bob, carol]
  }

  function connected(p: Phone): string[] {
    return p.engine
      .participants()
      .filter((x) => x.status === 'connected')
      .map((x) => x.peer)
      .sort()
  }

  it('links everyone to everyone, the smaller key dialling, with no server in between', async () => {
    const [alice, bob, carol] = await threeWay()
    for (const p of [alice, bob, carol]) expect(state(p)).toBe('active')
    expect(connected(alice)).toEqual([BOB, CAROL].sort())
    expect(connected(bob)).toEqual([ALICE, CAROL].sort())
    expect(connected(carol)).toEqual([ALICE, BOB].sort())
    expect(alice.pcs).toHaveLength(2)
    expect(bob.pcs).toHaveLength(2)
    expect(carol.pcs).toHaveLength(2)

    const carolMic = carol.made[0]!.getAudioTracks()[0]!
    const bobMic = bob.made[0]!.getAudioTracks()[0]!
    expect(bob.engine.participants().find((x) => x.peer === CAROL)?.stream?.getTracks()).toContain(carolMic)
    expect(carol.engine.participants().find((x) => x.peer === BOB)?.stream?.getTracks()).toContain(bobMic)

    carol.engine.toggleMute()
    await flush()
    expect(bob.engine.participants().find((x) => x.peer === CAROL)?.state.muted).toBe(true)
    expect(alice.engine.participants().find((x) => x.peer === CAROL)?.state.muted).toBe(true)
    expect(bob.engine.getSnapshot().context.remoteMuted).toBe(false)
  })

  it('goes on without someone who leaves, and records who was on it', async () => {
    const [alice, bob, carol] = await threeWay()
    carol.engine.hangUp()
    await flush()
    expect(state(alice)).toBe('active')
    expect(state(bob)).toBe('active')
    expect(connected(alice)).toEqual([BOB])
    expect(connected(bob)).toEqual([ALICE])
    expect(carol.records[0]).toMatchObject({ outcome: 'finished', direction: 'in' })
    expect(carol.records[0]!.peers.sort()).toEqual([ALICE, BOB].sort())

    alice.engine.hangUp()
    await flush()
    expect(state(bob)).toBe('ended')
    expect(alice.records[0]!.peers.sort()).toEqual([BOB, CAROL].sort())
  })

  it('keeps the others on when someone asked declines', async () => {
    const alice = phone(ALICE)
    const bob = phone(BOB)
    const carol = phone(CAROL)
    alice.engine.call(BOB)
    await flush()
    await bob.engine.accept()
    await flush()
    alice.engine.invite(CAROL)
    await flush()
    expect(alice.engine.participants().find((x) => x.peer === CAROL)?.status).toBe('ringing')
    carol.engine.decline()
    await flush()
    expect(state(alice)).toBe('active')
    expect(alice.engine.participants().map((x) => x.peer)).toEqual([BOB])
  })

  it('caps each video sender once there are more than two', async () => {
    const [alice, , carol] = await threeWay(true)
    const caps = () => alice.pcs.flatMap((pc) => pc.senders.filter((s) => s.track?.kind === 'video').map((s) => s.params.encodings[0]?.maxBitrate))
    expect(caps()).toEqual([600_000, 600_000])
    carol.engine.hangUp()
    await flush()
    const toBob = alice.pcs.find((pc) => pc.connectionState === 'connected')!
    expect(alice.pcs.filter((pc) => pc.connectionState === 'closed')).toHaveLength(1)
    expect(toBob.senders.find((s) => s.track?.kind === 'video')?.params.encodings[0]?.maxBitrate).toBeUndefined()
  })

  it('lets only the host ask people on, up to six on a call', async () => {
    const extra = [4, 5, 6, 7, 8].map((n) => '02' + String(n).repeat(64))
    const alice = phone(ALICE, { friends: [BOB, CAROL, ...extra] })
    const bob = phone(BOB)
    expect(alice.engine.invite(BOB)).toBe(false)
    alice.engine.call(BOB)
    expect(alice.engine.invite(ALICE)).toBe(false)
    expect(alice.engine.invite('02' + 'd'.repeat(64))).toBe(false)
    expect(alice.engine.invite(CAROL)).toBe(true)
    expect(alice.engine.invite(CAROL)).toBe(false)
    for (const key of extra.slice(0, 3)) expect(alice.engine.invite(key)).toBe(true)
    expect(alice.engine.canInvite()).toBe(false)
    expect(alice.engine.invite(extra[3]!)).toBe(false)
    await flush()
    expect(bob.engine.canInvite()).toBe(false)
  })

  it('ignores call frames from anyone not on the roster, and rosters from anyone but the host', async () => {
    const [alice, bob, carol] = await threeWay()
    const DAVE = '02' + 'd'.repeat(64)
    const call = bob.engine.getSnapshot().context.callId!
    bob.engine.ingest(DAVE, encodeCallFrame({ t: 'state', call, state: { muted: true, camera: false, sharing: false } }))
    bob.engine.ingest(DAVE, encodeCallFrame({ t: 'hangup', call }))
    carol.engine.ingest(BOB, encodeCallFrame({ t: 'roster', call, joined: [BOB, CAROL, DAVE] }))
    await flush()
    expect(bob.engine.getSnapshot().context.remote[DAVE]).toBeUndefined()
    expect(carol.engine.getSnapshot().context.members).not.toContain(DAVE)
    expect(carol.engine.inCall(DAVE)).toBe(false)
    expect(bob.engine.inCall(CAROL)).toBe(true)
    expect(state(alice)).toBe('active')
  })
})
