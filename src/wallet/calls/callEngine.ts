/**
 * Calls between friends: the call chart plus what it drives. Signalling is
 * call frames (`callWire.ts`) on the identity-authenticated direct session;
 * media is its own peer connection per leg (`mediaPeer.ts`). Nothing here
 * touches keys that spend, and nothing here moves funds.
 */

import { createActor, type SnapshotFrom } from 'xstate'
import { callMachine, type CallContext } from '../../machines/callMachine'
import type { CallRecord } from './callHistory'
import { encodeCallFrame, newCallId, parseCallFrame, type CallFrame } from './callWire'
import { cameraConstraints, cameraFailureText, micConstraints } from './mediaDevices'
import { createMediaPeer, type MediaPeer, type MediaRtcConstructor, type MediaSignal } from './mediaPeer'
import type { RingKind } from './ringtone'

export type CallSnapshot = SnapshotFrom<typeof callMachine>

/** How long a connection may stay disconnected before the call counts as dropped. */
export const CALL_DROP_MS = 10_000

export type CallEngineDeps = {
  /** Open, or find open, the authenticated direct session to `peer`; false when it does not open in time. */
  connect: (peer: string) => Promise<boolean>
  /** Send one frame on the open session; `box` means it did not arrive. */
  send: (peer: string, body: string) => Promise<'direct' | 'box'>
  rtc: () => MediaRtcConstructor | undefined
  iceServers: () => RTCIceServer[]
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>
  /** Whether a call from this identity may ring here (a friend who is not blocked). */
  mayRing: (peer: string) => boolean
  record: (record: CallRecord) => void
  ring: (kind: RingKind | null) => void
  now: () => number
  /** The microphone and camera the user picked last; null is the system default. */
  devices?: () => { mic: string | null; camera: string | null }
  rememberDevice?: (kind: 'mic' | 'camera', deviceId: string) => void
  log?: (what: string, err?: unknown) => void
}

type Leg = {
  peer: string
  media: MediaPeer | null
  /** Signals that arrived before this side made its media peer. */
  queued: MediaSignal[]
  senders: { audio?: RTCRtpSender; video?: RTCRtpSender }
}

function norm(key: string): string {
  return key.trim().toLowerCase()
}

export function micFailureText(err: unknown): string {
  const name = err instanceof Error ? err.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'HandCash isn’t allowed to use the microphone'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone found'
  if (name === 'NotReadableError') return 'The microphone is in use by another app'
  return 'The microphone didn’t start'
}

export function createCallEngine(deps: CallEngineDeps) {
  const log = deps.log ?? ((what: string, err?: unknown) => console.info(`[calls] ${what}${err === undefined ? '' : ` — ${err instanceof Error ? err.message : String(err)}`}`))
  const actor = createActor(callMachine)
  const listeners = new Set<() => void>()
  let leg: Leg | null = null
  let local: MediaStream | null = null
  let remote: MediaStream | null = null
  /** The far side already knows this call is over (it told us, or we told it). */
  let settled = false
  let finalized: string | null = null
  /** A dial dropped for glare: it ends without an Activity row. */
  let silent: string | null = null
  let dropTimer: ReturnType<typeof setTimeout> | undefined
  let version = 0
  /** The call whose state this side has announced since it went active. */
  let announced: string | null = null
  /** Why the camera did not start, for the call bar; cleared when it does. */
  let cameraProblem: string | null = null
  const devices = deps.devices ?? (() => ({ mic: null, camera: null }))

  function ctx(): CallContext {
    return actor.getSnapshot().context
  }

  function emit(): void {
    version += 1
    for (const listener of [...listeners]) listener()
  }

  function sendFrame(peer: string, frame: CallFrame): Promise<'direct' | 'box'> {
    return deps.send(peer, encodeCallFrame(frame)).catch((err) => {
      log('frame not sent', err)
      return 'box' as const
    })
  }

  function stopLocal(): void {
    for (const track of local?.getTracks() ?? []) track.stop()
    local = null
  }

  function teardown(): void {
    clearTimeout(dropTimer)
    leg?.media?.close()
    leg = null
    stopLocal()
    remote = null
  }

  function finalize(c: CallContext): void {
    if (!c.callId || finalized === c.callId) return
    finalized = c.callId
    const peer = c.peer!
    if (!settled) {
      settled = true
      if (c.outcome === 'missed' || (c.direction === 'in' && c.outcome === 'declined')) {
        void sendFrame(peer, { t: 'decline', call: c.callId, reason: c.outcome === 'missed' ? 'missed' : 'declined' })
      } else if (c.outcome !== 'unreachable') {
        void sendFrame(peer, {
          t: 'hangup',
          call: c.callId,
          reason: c.outcome === 'failed' ? 'failed' : c.outcome === 'finished' ? 'hung-up' : 'cancelled',
        })
      }
    }
    teardown()
    if (silent === c.callId) return
    deps.record({
      id: c.callId,
      peers: [peer],
      direction: c.direction,
      outcome: c.outcome ?? 'failed',
      video: c.video,
      startedAt: c.startedAt,
      connectedAt: c.connectedAt,
      endedAt: c.endedAt ?? deps.now(),
    })
  }

  actor.subscribe((snap) => {
    if (snap.matches('incoming')) deps.ring('ring')
    else if (snap.matches({ outgoing: 'ringing' })) deps.ring('ringback')
    else deps.ring(null)
    if (snap.matches('ended')) finalize(snap.context)
    // Each side says once whether its camera is on, so the other knows what to show.
    if (snap.matches('active') && announced !== snap.context.callId) {
      announced = snap.context.callId
      sendState()
    }
    emit()
  })
  actor.start()

  function busy(): boolean {
    const s = actor.getSnapshot()
    return !s.matches('idle') && !s.matches('ended')
  }

  function openLeg(peer: string, polite: boolean): void {
    const rtc = deps.rtc()
    if (!rtc) {
      actor.send({ type: 'FAIL', reason: 'Calls aren’t available in this window', at: deps.now() })
      return
    }
    const callId = ctx().callId!
    const current = leg ?? { peer, media: null, queued: [], senders: {} }
    leg = current
    const addLocal = () => {
      for (const track of local?.getTracks() ?? []) {
        const kind = track.kind === 'video' ? 'video' : 'audio'
        if (!current.senders[kind]) current.senders[kind] = current.media?.addTrack(track, local!)
      }
    }
    current.media = createMediaPeer({
      rtc,
      iceServers: deps.iceServers(),
      polite,
      log,
      send: (signal) => {
        if (ctx().callId !== callId) return
        void sendFrame(
          peer,
          signal.kind === 'sdp'
            ? { t: 'sdp', call: callId, description: signal.description }
            : { t: 'ice', call: callId, candidate: signal.candidate },
        )
      },
      onTrack: (track, stream) => {
        if (ctx().callId !== callId) return
        if (!remote) remote = stream ?? new MediaStream()
        if (!remote.getTracks().includes(track)) remote.addTrack(track)
        emit()
      },
      onState: (state) => {
        if (ctx().callId !== callId) return
        clearTimeout(dropTimer)
        if (state === 'connected') actor.send({ type: 'MEDIA_CONNECTED', at: deps.now() })
        else if (state === 'failed') actor.send({ type: 'FAIL', reason: 'The connection to them failed', at: deps.now() })
        else if (state === 'disconnected') {
          // A blip recovers by itself; a closed laptop on the far side does not.
          dropTimer = setTimeout(() => {
            if (ctx().callId === callId) actor.send({ type: 'FAIL', reason: 'The connection to them dropped', at: deps.now() })
          }, CALL_DROP_MS)
        }
      },
      beforeAnswer: polite ? addLocal : undefined,
    })
    if (!polite) addLocal()
    for (const signal of current.queued.splice(0)) void current.media.handle(signal)
  }

  function sendState(): void {
    const s = actor.getSnapshot()
    if (!s.matches('active') && !s.matches('connecting')) return
    const { muted, camera, callId, peer } = s.context
    void sendFrame(peer!, { t: 'state', call: callId!, state: { muted, camera } })
  }

  /** A camera that will not start leaves the call going as voice. */
  async function openCamera(deviceId: string | null, exact: boolean): Promise<MediaStreamTrack | null> {
    try {
      const stream = await deps.getUserMedia({ video: cameraConstraints(deviceId, exact) })
      return stream.getVideoTracks()[0] ?? null
    } catch (err) {
      log('camera refused', err)
      cameraProblem = cameraFailureText(err)
      emit()
      return null
    }
  }

  /** Opens the mic, and the camera when this side starts with it on. */
  async function openMedia(): Promise<boolean> {
    const callId = ctx().callId
    const pref = devices()
    let stream: MediaStream
    try {
      stream = await deps.getUserMedia({ audio: micConstraints(pref.mic) })
    } catch (err) {
      log('microphone refused', err)
      if (ctx().callId === callId) actor.send({ type: 'FAIL', reason: micFailureText(err), at: deps.now() })
      return false
    }
    const cam = ctx().camera ? await openCamera(pref.camera, false) : null
    if (ctx().callId !== callId || !busy()) {
      for (const track of [...stream.getTracks(), ...(cam ? [cam] : [])]) track.stop()
      return false
    }
    if (cam) stream.addTrack(cam)
    else if (ctx().camera) actor.send({ type: 'CAMERA', on: false })
    local = stream
    for (const track of stream.getAudioTracks()) track.enabled = !ctx().muted
    emit()
    return true
  }

  function localTrack(kind: 'audio' | 'video'): MediaStreamTrack | undefined {
    return kind === 'audio' ? local?.getAudioTracks()[0] : local?.getVideoTracks()[0]
  }

  /** Puts `track` in place of this side's current one of its kind, on the wire and in the preview. */
  async function swapTrack(kind: 'audio' | 'video', track: MediaStreamTrack | null): Promise<void> {
    const old = localTrack(kind)
    if (old) {
      local?.removeTrack(old)
      old.stop()
    }
    if (track && local) local.addTrack(track)
    const sender = leg?.senders[kind]
    if (sender) await sender.replaceTrack(track).catch((err) => log('track not replaced', err))
    else if (track && local && leg?.media) leg.senders[kind] = leg.media.addTrack(track, local)
    emit()
  }

  async function dial(peerKey: string): Promise<void> {
    const peer = norm(peerKey)
    const callId = ctx().callId
    const live = () => ctx().callId === callId && busy()
    if (!(await openMedia()) || !live()) return
    const reached = await deps.connect(peer).catch((err) => {
      log('session did not open', err)
      return false
    })
    if (!live()) return
    if (!reached) {
      actor.send({ type: 'UNREACHABLE', at: deps.now() })
      return
    }
    const sent = await sendFrame(peer, { t: 'invite', call: callId!, video: ctx().video })
    if (!live() || !actor.getSnapshot().matches({ outgoing: 'reaching' })) return
    if (sent === 'direct') actor.send({ type: 'REACHED' })
    else actor.send({ type: 'UNREACHABLE', at: deps.now() })
  }

  function onInvite(peer: string, frame: Extract<CallFrame, { t: 'invite' }>): void {
    if (!deps.mayRing(peer)) return
    const s = actor.getSnapshot()
    const c = s.context
    if (c.callId === frame.call) return
    if (s.matches('outgoing') && c.peer === peer) {
      // Both dialled at once: the larger call id yields and answers the other.
      if (c.callId! < frame.call) return
      silent = c.callId
      settled = true
      actor.send({ type: 'HANG_UP', at: deps.now() })
      actor.send({ type: 'INCOMING', callId: frame.call, peer, video: frame.video, at: deps.now() })
      settled = false
      void accept()
      return
    }
    if (busy()) {
      void sendFrame(peer, { t: 'decline', call: frame.call, reason: 'busy' })
      deps.record({
        id: frame.call,
        peers: [peer],
        direction: 'in',
        outcome: 'missed',
        video: frame.video,
        startedAt: deps.now(),
        connectedAt: null,
        endedAt: deps.now(),
      })
      return
    }
    settled = false
    cameraProblem = null
    actor.send({ type: 'INCOMING', callId: frame.call, peer, video: frame.video, at: deps.now() })
  }

  /** Answer the ringing call; `video` defaults to how the caller called. */
  async function accept(opts: { video?: boolean } = {}): Promise<void> {
    if (!actor.getSnapshot().matches('incoming')) return
    const { callId, peer, video } = ctx()
    actor.send({ type: 'ACCEPT', video: opts.video ?? video })
    if (!(await openMedia()) || ctx().callId !== callId) return
    openLeg(peer!, true)
    const sent = await sendFrame(peer!, { t: 'accept', call: callId! })
    if (sent !== 'direct' && ctx().callId === callId) {
      actor.send({ type: 'FAIL', reason: 'Lost the connection to them', at: deps.now() })
    }
  }

  return {
    /** Start a call to a friend. False when another call is under way. */
    call(peerKey: string, opts: { video?: boolean } = {}): boolean {
      if (busy()) return false
      const peer = norm(peerKey)
      settled = false
      cameraProblem = null
      actor.send({ type: 'DIAL', callId: newCallId(), peer, video: opts.video === true, at: deps.now() })
      void dial(peer)
      return true
    },

    accept,

    decline(): void {
      if (!actor.getSnapshot().matches('incoming')) return
      actor.send({ type: 'DECLINE', at: deps.now() })
    },

    hangUp(): void {
      if (!busy()) return
      if (actor.getSnapshot().matches('incoming')) {
        actor.send({ type: 'DECLINE', at: deps.now() })
        return
      }
      actor.send({ type: 'HANG_UP', at: deps.now() })
    },

    toggleMute(): void {
      if (!busy()) return
      actor.send({ type: 'TOGGLE_MUTE' })
      const { muted } = ctx()
      for (const track of local?.getAudioTracks() ?? []) track.enabled = !muted
      sendState()
    },

    /** Turn this side’s camera on or off; off releases the camera, so its light goes out. */
    async setCamera(on: boolean): Promise<void> {
      if (!busy() || actor.getSnapshot().matches('incoming') || ctx().camera === on) return
      const callId = ctx().callId
      if (!on) {
        actor.send({ type: 'CAMERA', on: false })
        await swapTrack('video', null)
        sendState()
        return
      }
      cameraProblem = null
      const track = await openCamera(devices().camera, false)
      if (!track) return
      if (ctx().callId !== callId || !busy() || !local) {
        track.stop()
        return
      }
      actor.send({ type: 'CAMERA', on: true })
      await swapTrack('video', track)
      sendState()
    },

    /** Use this camera from now on, switching to it at once when the camera is on. */
    async useCamera(deviceId: string): Promise<void> {
      deps.rememberDevice?.('camera', deviceId)
      if (!busy() || !ctx().camera || localTrack('video')?.getSettings().deviceId === deviceId) return
      const callId = ctx().callId
      const track = await openCamera(deviceId, true)
      if (!track) return
      if (ctx().callId !== callId || !ctx().camera) {
        track.stop()
        return
      }
      cameraProblem = null
      await swapTrack('video', track)
    },

    /** Use this microphone from now on, switching to it at once during a call. */
    async useMic(deviceId: string): Promise<void> {
      deps.rememberDevice?.('mic', deviceId)
      if (!local || localTrack('audio')?.getSettings().deviceId === deviceId) return
      const callId = ctx().callId
      let track: MediaStreamTrack | undefined
      try {
        track = (await deps.getUserMedia({ audio: micConstraints(deviceId, true) })).getAudioTracks()[0]
      } catch (err) {
        log('microphone not switched', err)
        return
      }
      if (!track) return
      if (ctx().callId !== callId || !local) {
        track.stop()
        return
      }
      track.enabled = !ctx().muted
      await swapTrack('audio', track)
    },

    /** The devices this call is using now, by id. */
    devicesInUse(): { mic: string | null; camera: string | null } {
      return {
        mic: (localTrack('audio')?.getSettings().deviceId as string | undefined) ?? null,
        camera: (localTrack('video')?.getSettings().deviceId as string | undefined) ?? null,
      }
    },

    cameraProblem(): string | null {
      return cameraProblem
    },

    dismiss(): void {
      if (actor.getSnapshot().matches('ended')) actor.send({ type: 'DISMISS' })
    },

    /** A body from the direct session. True when it was a call frame (handled or not). */
    ingest(senderKey: string, body: string): boolean {
      const frame = parseCallFrame(body)
      if (!frame) return false
      const peer = norm(senderKey)
      if (frame.t === 'invite') {
        onInvite(peer, frame)
        return true
      }
      const c = ctx()
      if (c.callId !== frame.call || c.peer !== peer) return true
      switch (frame.t) {
        case 'accept':
          if (actor.getSnapshot().matches('outgoing')) {
            actor.send({ type: 'REMOTE_ACCEPTED' })
            openLeg(peer, false)
          }
          break
        case 'decline':
          settled = true
          if (actor.getSnapshot().matches('outgoing')) {
            actor.send({ type: 'REMOTE_DECLINED', busy: frame.reason === 'busy', at: deps.now() })
          } else {
            actor.send({ type: 'REMOTE_HUNG_UP', at: deps.now() })
          }
          break
        case 'hangup':
          settled = true
          if (frame.reason === 'failed' && !actor.getSnapshot().matches('incoming')) {
            actor.send({ type: 'FAIL', reason: 'The connection to them failed', at: deps.now() })
          } else if (actor.getSnapshot().matches('outgoing')) {
            actor.send({ type: 'REMOTE_DECLINED', busy: false, at: deps.now() })
          } else {
            actor.send({ type: 'REMOTE_HUNG_UP', at: deps.now() })
          }
          break
        case 'state':
          actor.send({ type: 'REMOTE_STATE', muted: frame.state.muted, camera: frame.state.camera })
          break
        case 'sdp':
        case 'ice': {
          const signal: MediaSignal =
            frame.t === 'sdp' ? { kind: 'sdp', description: frame.description } : { kind: 'ice', candidate: frame.candidate }
          if (!leg) leg = { peer, media: null, queued: [], senders: {} }
          if (leg.media) void leg.media.handle(signal)
          else leg.queued.push(signal)
          break
        }
      }
      return true
    },

    /** End whatever is under way, e.g. on lock or account switch. */
    endAll(): void {
      if (!busy()) return
      if (actor.getSnapshot().matches('incoming')) actor.send({ type: 'DECLINE', at: deps.now() })
      else actor.send({ type: 'HANG_UP', at: deps.now() })
    },

    getSnapshot(): CallSnapshot {
      return actor.getSnapshot()
    },

    /** Bumps on every change, chart or media, for `useSyncExternalStore`. */
    version(): number {
      return version
    },

    localStream(): MediaStream | null {
      return local
    },

    remoteStream(): MediaStream | null {
      return remote
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    stop(): void {
      teardown()
      deps.ring(null)
      actor.stop()
    },
  }
}

export type CallEngine = ReturnType<typeof createCallEngine>
