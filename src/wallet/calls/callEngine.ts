/**
 * Calls between friends: the call chart plus what it drives. Signalling is
 * call frames (`callWire.ts`) on the identity-authenticated direct session;
 * media is its own peer connection per leg (`mediaPeer.ts`), its frames sealed
 * under keys only the two identity keys of that leg can derive (`mediaKeys.ts`).
 *
 * A group call is a full mesh, one leg between every two people and no media
 * server: the host asks people on and tells everyone who has joined (`roster`),
 * and of each two members the one with the smaller identity key dials the
 * other. Frames count only from people the host's roster names, and no call
 * grows past `CALL_MAX_PARTICIPANTS`, which a home uplink carries. Nothing
 * here touches keys that spend, and nothing here moves funds.
 */

import { createActor, type SnapshotFrom } from 'xstate'
import { callMachine, type CallContext } from '../../machines/callMachine'
import type { CallRecord } from './callHistory'
import {
  CALL_MAX_PARTICIPANTS,
  encodeCallFrame,
  newCallId,
  parseCallFrame,
  type CallFrame,
  type CallMediaState,
} from './callWire'
import type { FrameProtector } from './frameProtector'
import { cameraConstraints, cameraFailureText, micConstraints } from './mediaDevices'
import { callKeys, safetyCode, type CallKeys } from './mediaKeys'
import { createMediaPeer, type MediaPeer, type MediaRtcConstructor, type MediaSignal } from './mediaPeer'
import type { RingKind } from './ringtone'

export type CallSnapshot = SnapshotFrom<typeof callMachine>

/** How long a connection may stay disconnected before the call counts as dropped. */
export const CALL_DROP_MS = 10_000
/** Each video sender's ceiling once a call has more than two people, so the mesh fits a home uplink. */
export const GROUP_VIDEO_BITRATE = 600_000
/** Signals kept for a member the roster has not named yet, or a leg not opened yet. */
const SIGNALS_KEPT = 64

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
  /** This identity: media keys run from it to each peer, and members of a group call order by it. */
  self?: () => string
  /** The microphone and camera the user picked last; null is the system default. */
  devices?: () => { mic: string | null; camera: string | null }
  rememberDevice?: (kind: 'mic' | 'camera', deviceId: string) => void
  /** A screen or window the user just picked, as a stream; absent where sharing is not possible. */
  captureScreen?: (sourceId: string) => Promise<MediaStream>
  screenFailureText?: (err: unknown) => string
  /**
   * End-to-end media keys: the secret this identity shares with `peer` for
   * one call, and what seals and opens frames with the keys made from it.
   * Absent, media rests on DTLS-SRTP alone.
   */
  e2ee?: {
    secret: (peer: string, callId: string) => Promise<Uint8Array>
    protector: (keys: CallKeys, onUnreadable: () => void) => FrameProtector
  }
  log?: (what: string, err?: unknown) => void
}

type Sealed = { secret: Uint8Array; protector: FrameProtector }

/** The media leg to one other person. */
type Leg = {
  peer: string
  media: MediaPeer | null
  /** Waiting for this leg's keys before its media peer exists. */
  opening: boolean
  /** Signals that arrived before this side made its media peer. */
  queued: MediaSignal[]
  senders: { audio?: RTCRtpSender; video?: RTCRtpSender }
  remote: MediaStream | null
  sealed: Promise<Sealed | null> | null
  safety: string | null
  /** Their frames stopped opening under this leg's keys. */
  unreadable: boolean
  dropTimer?: ReturnType<typeof setTimeout>
}

/** One other person on the call, as the dock shows them. */
export type CallParticipant = {
  peer: string
  /** `ringing`: asked on by this side, not answered yet. */
  status: 'ringing' | 'connecting' | 'connected'
  stream: MediaStream | null
  state: CallMediaState
  safety: string | null
}

type InviteeStatus = 'ringing' | 'joined' | 'declined' | 'busy' | 'gone'

const QUIET: CallMediaState = { muted: false, camera: false, sharing: false }

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

function signalOf(frame: Extract<CallFrame, { t: 'sdp' | 'ice' }>): MediaSignal {
  return frame.t === 'sdp' ? { kind: 'sdp', description: frame.description } : { kind: 'ice', candidate: frame.candidate }
}

export function createCallEngine(deps: CallEngineDeps) {
  const log = deps.log ?? ((what: string, err?: unknown) => console.info(`[calls] ${what}${err === undefined ? '' : ` — ${err instanceof Error ? err.message : String(err)}`}`))
  const actor = createActor(callMachine)
  const listeners = new Set<() => void>()
  const legs = new Map<string, Leg>()
  /** Who may send this call's frames: the other side, or everyone the host has named. */
  const roster = new Set<string>()
  /** The host's view of everyone it asked on. */
  const invitees = new Map<string, InviteeStatus>()
  /** Told this side they are off the call; nothing more goes to them. */
  const gone = new Set<string>()
  /** Signals from a member the host has not named yet. */
  const stray = new Map<string, MediaSignal[]>()
  let local: MediaStream | null = null
  /** The far side already knows this call is over (it told us, or we told it). */
  let settled = false
  let finalized: string | null = null
  /** A dial dropped for glare: it ends without an Activity row. */
  let silent: string | null = null
  let version = 0
  /** Why the camera did not start, for the call bar; cleared when it does. */
  let cameraProblem: string | null = null
  let shareProblem: string | null = null
  /** The screen or window track being sent in place of the camera. */
  let screen: MediaStreamTrack | null = null
  const devices = deps.devices ?? (() => ({ mic: null, camera: null }))

  function ctx(): CallContext {
    return actor.getSnapshot().context
  }

  function me(): string {
    return norm(deps.self?.() ?? '')
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

  function legFor(peer: string): Leg {
    let leg = legs.get(peer)
    if (!leg) {
      leg = { peer, media: null, opening: false, queued: [], senders: {}, remote: null, sealed: null, safety: null, unreadable: false }
      legs.set(peer, leg)
    }
    return leg
  }

  function liveLegs(): Leg[] {
    return [...legs.values()].filter((leg) => leg.media)
  }

  function closeLeg(leg: Leg): void {
    clearTimeout(leg.dropTimer)
    leg.media?.close()
    void leg.sealed?.then((s) => s?.protector.close())
  }

  /** A new call starts with nobody named but `peer`. */
  function startRoster(peer: string): void {
    roster.clear()
    invitees.clear()
    gone.clear()
    stray.clear()
    roster.add(peer)
  }

  function teardown(): void {
    screen = null
    for (const leg of legs.values()) closeLeg(leg)
    legs.clear()
    stray.clear()
    stopLocal()
  }

  /** Everyone still owed word that this side is leaving. */
  function farSides(c: CallContext): string[] {
    const out = new Set<string>()
    if (c.peer) out.add(c.peer)
    for (const peer of legs.keys()) out.add(peer)
    for (const [peer, status] of invitees) if (status === 'ringing' || status === 'joined') out.add(peer)
    return [...out].filter((peer) => !gone.has(peer))
  }

  function finalize(c: CallContext): void {
    if (!c.callId || finalized === c.callId) return
    finalized = c.callId
    if (!settled) {
      settled = true
      if (c.outcome === 'missed' || (c.direction === 'in' && c.outcome === 'declined')) {
        if (!gone.has(c.peer!)) {
          void sendFrame(c.peer!, { t: 'decline', call: c.callId, reason: c.outcome === 'missed' ? 'missed' : 'declined' })
        }
      } else if (c.outcome !== 'unreachable') {
        const reason = c.outcome === 'failed' ? 'failed' : c.outcome === 'finished' ? 'hung-up' : 'cancelled'
        for (const peer of farSides(c)) void sendFrame(peer, { t: 'hangup', call: c.callId, reason })
      }
    }
    teardown()
    if (silent === c.callId) return
    deps.record({
      id: c.callId,
      peers: c.members.length > 0 ? [...c.members] : [c.peer!],
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
    emit()
  })
  actor.start()

  function busy(): boolean {
    const s = actor.getSnapshot()
    return !s.matches('idle') && !s.matches('ended')
  }

  function accepted(): boolean {
    const s = actor.getSnapshot()
    return s.matches('connecting') || s.matches('active')
  }

  /** Start deriving this leg's media keys; the same promise for the rest of the leg. */
  function secure(leg: Leg, callId: string): Promise<Sealed | null> | null {
    const e2ee = deps.e2ee
    if (!e2ee) return null
    leg.sealed ??= (async () => {
      const secret = await e2ee.secret(leg.peer, callId)
      const keys = await callKeys(secret, me(), leg.peer, callId)
      const protector = e2ee.protector(keys, () => {
        if (ctx().callId !== callId || leg.unreadable) return
        leg.unreadable = true
        emit()
      })
      return { secret, protector }
    })().catch((err) => {
      log('media keys not agreed', err)
      return null
    })
    return leg.sealed
  }

  async function showSafetyCode(leg: Leg, callId: string): Promise<void> {
    const sealed = await leg.sealed
    const media = leg.media
    if (!sealed || !media || ctx().callId !== callId || legs.get(leg.peer) !== leg) return
    const code = await safetyCode(sealed.secret, callId, [media.localFingerprint(), media.remoteFingerprint()])
    if (ctx().callId !== callId || legs.get(leg.peer) !== leg) return
    leg.safety = code
    emit()
  }

  /** Video stays within a home uplink once it goes to more than one person. */
  function capVideo(): void {
    const group = liveLegs().length > 1
    for (const leg of liveLegs()) {
      const sender = leg.senders.video
      if (!sender || typeof sender.getParameters !== 'function') continue
      const params = sender.getParameters()
      const encoding = params.encodings?.[0]
      if (!encoding) continue
      const want = group ? GROUP_VIDEO_BITRATE : undefined
      if (encoding.maxBitrate === want) continue
      if (want === undefined) delete encoding.maxBitrate
      else encoding.maxBitrate = want
      void sender.setParameters(params).catch((err) => log('video bitrate not set', err))
    }
  }

  /** People asked on who have not answered, or answered and are still setting up. */
  function stillComing(): boolean {
    return [...invitees.values()].some((s) => s === 'ringing' || s === 'joined') || [...legs.values()].some((leg) => leg.opening)
  }

  /** Nobody left to talk to: the call ends the way the chart reads it. */
  function endIfAlone(failed: boolean): void {
    if (!busy() || liveLegs().length > 0 || stillComing()) return
    const s = actor.getSnapshot()
    const at = deps.now()
    if (s.matches('outgoing')) {
      const answers = [...invitees.values()]
      actor.send({ type: 'REMOTE_DECLINED', busy: answers.length > 0 && answers.every((a) => a === 'busy'), at })
    } else if (failed && !s.matches('incoming')) {
      actor.send({ type: 'FAIL', reason: 'The connection to them failed', at })
    } else {
      actor.send({ type: 'REMOTE_HUNG_UP', at })
    }
  }

  /** `peer` is off this call: its leg closes, and the call goes on if anyone is left. */
  function drop(peer: string, how: 'declined' | 'busy' | 'failed'): void {
    gone.add(peer)
    const was = invitees.get(peer)
    if (was) invitees.set(peer, how === 'busy' ? 'busy' : was === 'ringing' ? 'declined' : 'gone')
    stray.delete(peer)
    const leg = legs.get(peer)
    if (leg) {
      closeLeg(leg)
      legs.delete(peer)
      if (ctx().joined.includes(peer)) actor.send({ type: 'LEFT', peer })
      capVideo()
    }
    endIfAlone(how === 'failed')
    emit()
  }

  /** One leg failed: with others still on, it goes alone; otherwise the call fails. */
  function legFailed(peer: string, reason: string): void {
    if (liveLegs().some((leg) => leg.peer !== peer)) {
      log(`leg to ${peer.slice(0, 8)} dropped: ${reason}`)
      if (!gone.has(peer)) void sendFrame(peer, { t: 'hangup', call: ctx().callId!, reason: 'failed' })
      drop(peer, 'failed')
      return
    }
    actor.send({ type: 'FAIL', reason, at: deps.now() })
  }

  function sendState(only?: string): void {
    const s = actor.getSnapshot()
    if (!s.matches('active') && !s.matches('connecting')) return
    const { muted, camera, sharing, callId } = s.context
    const state = { muted, camera: camera && !sharing, sharing }
    for (const leg of liveLegs()) {
      if (!only || leg.peer === only) void sendFrame(leg.peer, { t: 'state', call: callId!, state })
    }
  }

  async function openLeg(peer: string, polite: boolean): Promise<void> {
    const rtc = deps.rtc()
    if (!rtc) {
      actor.send({ type: 'FAIL', reason: 'Calls aren’t available in this window', at: deps.now() })
      return
    }
    const callId = ctx().callId!
    const current = legFor(peer)
    if (current.media || current.opening) return
    current.opening = true
    const sealing = secure(current, callId)
    const sealed = sealing ? await sealing : undefined
    current.opening = false
    if (ctx().callId !== callId || !busy() || legs.get(peer) !== current) return
    if (sealed === null) {
      legFailed(peer, 'Couldn’t agree the call’s encryption keys')
      return
    }
    const addLocal = () => {
      for (const track of local?.getTracks() ?? []) {
        const kind = track.kind === 'video' ? 'video' : 'audio'
        if (!current.senders[kind]) current.senders[kind] = current.media?.addTrack(track, local!)
      }
    }
    const stale = () => ctx().callId !== callId || legs.get(peer) !== current
    current.media = createMediaPeer({
      rtc,
      iceServers: deps.iceServers(),
      polite,
      log,
      frames: sealed?.protector,
      send: (signal) => {
        if (stale()) return
        void sendFrame(
          peer,
          signal.kind === 'sdp'
            ? { t: 'sdp', call: callId, description: signal.description }
            : { t: 'ice', call: callId, candidate: signal.candidate },
        )
      },
      onTrack: (track, stream) => {
        if (stale()) return
        if (!current.remote) current.remote = stream ?? new MediaStream()
        if (!current.remote.getTracks().includes(track)) current.remote.addTrack(track)
        emit()
      },
      onState: (state) => {
        if (stale()) return
        clearTimeout(current.dropTimer)
        if (state === 'connected') {
          actor.send({ type: 'JOINED', peer })
          actor.send({ type: 'MEDIA_CONNECTED', at: deps.now() })
          sendState(peer)
          capVideo()
          if (!current.safety) void showSafetyCode(current, callId)
        } else if (state === 'failed') {
          legFailed(peer, 'The connection to them failed')
        } else if (state === 'disconnected') {
          // A blip recovers by itself; a closed laptop on the far side does not.
          current.dropTimer = setTimeout(() => {
            if (!stale()) legFailed(peer, 'The connection to them dropped')
          }, CALL_DROP_MS)
        }
      },
      beforeAnswer: polite ? addLocal : undefined,
    })
    if (!polite) addLocal()
    for (const signal of current.queued.splice(0)) void current.media.handle(signal)
    emit()
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

  /** Back from the shared screen to the camera, or to no video when the camera is off. */
  async function stopShare(): Promise<void> {
    if (!screen) return
    const callId = ctx().callId
    screen = null
    actor.send({ type: 'SHARE', on: false })
    const cam = ctx().camera ? await openCamera(devices().camera, false) : null
    if (ctx().callId !== callId || !busy()) {
      cam?.stop()
      return
    }
    if (ctx().camera && !cam) actor.send({ type: 'CAMERA', on: false })
    await swapTrack('video', cam)
    sendState()
  }

  /** Puts `track` in place of this side's current one of its kind, in the preview and on every leg. */
  async function swapTrack(kind: 'audio' | 'video', track: MediaStreamTrack | null): Promise<void> {
    const old = localTrack(kind)
    if (old) {
      local?.removeTrack(old)
      old.stop()
    }
    if (track && local) local.addTrack(track)
    for (const leg of liveLegs()) {
      const sender = leg.senders[kind]
      if (sender) await sender.replaceTrack(track).catch((err) => log('track not replaced', err))
      else if (track && local && leg.media) leg.senders[kind] = leg.media.addTrack(track, local)
    }
    if (kind === 'video') capVideo()
    emit()
  }

  async function dial(peerKey: string): Promise<void> {
    const peer = norm(peerKey)
    const callId = ctx().callId
    const live = () => ctx().callId === callId && busy()
    void secure(legFor(peer), callId!)
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

  /** The host asks one more friend onto the call under way. */
  async function ask(peer: string): Promise<void> {
    const callId = ctx().callId
    const live = () => ctx().callId === callId && busy() && invitees.get(peer) === 'ringing'
    void secure(legFor(peer), callId!)
    const reached = await deps.connect(peer).catch((err) => {
      log('session did not open', err)
      return false
    })
    if (!live()) return
    const sent = reached
      ? await sendFrame(peer, { t: 'invite', call: callId!, video: ctx().video, members: [...roster] })
      : 'box'
    if (live() && sent !== 'direct') drop(peer, 'declined')
  }

  /** Of two members, the smaller key dials: open a session to `peer` and offer it this side's media. */
  async function link(peer: string): Promise<void> {
    const callId = ctx().callId
    void secure(legFor(peer), callId!)
    const reached = await deps.connect(peer).catch((err) => {
      log('session did not open', err)
      return false
    })
    if (ctx().callId !== callId || !busy() || gone.has(peer)) return
    if (!reached) {
      log(`member ${peer.slice(0, 8)} not reached`)
      return
    }
    await openLeg(peer, false)
  }

  function onInvite(peer: string, frame: Extract<CallFrame, { t: 'invite' }>): void {
    if (!deps.mayRing(peer)) return
    const s = actor.getSnapshot()
    const c = s.context
    if (c.callId === frame.call) return
    const others = (frame.members ?? []).filter((k) => k !== peer && k !== me())
    if (!frame.members && s.matches('outgoing') && c.peer === peer && invitees.size === 1) {
      // Both dialled at once: the larger call id yields and answers the other.
      if (c.callId! < frame.call) return
      silent = c.callId
      settled = true
      actor.send({ type: 'HANG_UP', at: deps.now() })
      startRoster(peer)
      actor.send({ type: 'INCOMING', callId: frame.call, peer, video: frame.video, at: deps.now() })
      settled = false
      void accept()
      return
    }
    if (busy()) {
      void sendFrame(peer, { t: 'decline', call: frame.call, reason: 'busy' })
      deps.record({
        id: frame.call,
        peers: [peer, ...others],
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
    startRoster(peer)
    actor.send({ type: 'INCOMING', callId: frame.call, peer, video: frame.video, at: deps.now(), members: [peer, ...others] })
  }

  /** Answer the ringing call; `video` defaults to how the caller called. */
  async function accept(opts: { video?: boolean } = {}): Promise<void> {
    if (!actor.getSnapshot().matches('incoming')) return
    const { callId, peer, video } = ctx()
    actor.send({ type: 'ACCEPT', video: opts.video ?? video })
    void secure(legFor(peer!), callId!)
    if (!(await openMedia()) || ctx().callId !== callId) return
    await openLeg(peer!, true)
    if (ctx().callId !== callId || !busy()) return
    const sent = await sendFrame(peer!, { t: 'accept', call: callId! })
    if (sent !== 'direct' && ctx().callId === callId) {
      actor.send({ type: 'FAIL', reason: 'Lost the connection to them', at: deps.now() })
    }
  }

  /** Host side: someone it asked on answered. */
  function onAccept(peer: string): void {
    if (ctx().direction !== 'out' || invitees.get(peer) !== 'ringing') return
    invitees.set(peer, 'joined')
    if (actor.getSnapshot().matches('outgoing')) actor.send({ type: 'REMOTE_ACCEPTED' })
    if (!accepted()) return
    void openLeg(peer, false)
    const joined = [...invitees].filter(([, s]) => s === 'joined').map(([k]) => k)
    if (joined.length < 2) return
    for (const member of joined) void sendFrame(member, { t: 'roster', call: ctx().callId!, joined })
  }

  /** Member side: the host says who has joined; link up with anyone new. */
  function onRoster(from: string, joined: string[]): void {
    const c = ctx()
    const self = me()
    if (c.direction !== 'in' || from !== c.peer || !self || !accepted()) return
    const added: string[] = []
    for (const key of joined) {
      if (key === self || key === from || roster.has(key) || gone.has(key)) continue
      if (roster.size + 1 >= CALL_MAX_PARTICIPANTS) break
      roster.add(key)
      added.push(key)
      const early = stray.get(key) ?? []
      stray.delete(key)
      const leg = legFor(key)
      leg.queued.push(...early)
      if (self < key) void link(key)
      else if (early.length > 0) void openLeg(key, true)
    }
    if (added.length > 0) actor.send({ type: 'MEMBERS', members: [...new Set([...c.members, ...added])] })
  }

  function onSignal(peer: string, signal: MediaSignal): void {
    const leg = legFor(peer)
    if (leg.media) {
      void leg.media.handle(signal)
      return
    }
    if (leg.queued.length < SIGNALS_KEPT) leg.queued.push(signal)
    // Between two members, the larger key answers the other's offer.
    if (ctx().direction === 'in' && peer !== ctx().peer && accepted()) void openLeg(peer, true)
  }

  function keepStray(peer: string, signal: MediaSignal): void {
    if (!stray.has(peer) && stray.size >= CALL_MAX_PARTICIPANTS) return
    const kept = stray.get(peer) ?? []
    if (kept.length < SIGNALS_KEPT) kept.push(signal)
    stray.set(peer, kept)
  }

  return {
    /** Start a call to a friend. False when another call is under way. */
    call(peerKey: string, opts: { video?: boolean } = {}): boolean {
      if (busy()) return false
      const peer = norm(peerKey)
      settled = false
      cameraProblem = null
      startRoster(peer)
      invitees.set(peer, 'ringing')
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
      if (screen) {
        // The share holds the video; the camera follows this choice when it stops.
        actor.send({ type: 'CAMERA', on })
        return
      }
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
      if (!busy() || !ctx().camera || screen || localTrack('video')?.getSettings().deviceId === deviceId) return
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
        camera: screen ? null : ((localTrack('video')?.getSettings().deviceId as string | undefined) ?? null),
      }
    },

    cameraProblem(): string | null {
      return cameraProblem
    },

    canShareScreen(): boolean {
      return !!deps.captureScreen
    },

    /** Send this screen or window in place of the camera until `stopSharing` or the source goes away. */
    async shareScreen(sourceId: string): Promise<void> {
      const s = actor.getSnapshot()
      if (!deps.captureScreen || !local || (!s.matches('active') && !s.matches('connecting'))) return
      const callId = ctx().callId
      shareProblem = null
      let track: MediaStreamTrack | undefined
      try {
        track = (await deps.captureScreen(sourceId)).getVideoTracks()[0]
      } catch (err) {
        log('screen share refused', err)
        shareProblem = deps.screenFailureText?.(err) ?? 'Screen sharing didn’t start'
        emit()
        return
      }
      if (!track) return
      if (ctx().callId !== callId || !busy() || !local) {
        track.stop()
        return
      }
      if ('contentHint' in track) track.contentHint = 'detail'
      const shared = track
      // Stopping from the system (or the window closing) ends the share like the button does.
      shared.addEventListener('ended', () => {
        if (screen === shared) void stopShare()
      })
      screen = shared
      actor.send({ type: 'SHARE', on: true })
      await swapTrack('video', shared)
      sendState()
    },

    stopSharing(): Promise<void> {
      return stopShare()
    },

    shareProblem(): string | null {
      return shareProblem
    },
    /** Whether every connected leg's media is sealed under identity-bound keys. */
    encrypted(): boolean {
      const live = liveLegs()
      return !!deps.e2ee && live.length > 0 && live.every((leg) => !!leg.safety)
    },

    /** The two-person call's safety code; null until media connects. Group calls carry one per participant. */
    safetyCode(): string | null {
      const peer = ctx().peer
      return peer ? (legs.get(peer)?.safety ?? null) : null
    },

    /** Why someone's audio and video are not playing, when their frames do not open. */
    e2eProblem(): string | null {
      return [...legs.values()].some((leg) => leg.unreadable) ? 'Their audio and video can’t be decrypted' : null
    },

    /** The host may ask another friend on while seats are left. */
    canInvite(): boolean {
      const s = actor.getSnapshot()
      if (s.context.direction !== 'out' || !(s.matches('outgoing') || s.matches('connecting') || s.matches('active'))) return false
      const seats = 1 + [...invitees.values()].filter((v) => v === 'ringing' || v === 'joined').length
      return seats < CALL_MAX_PARTICIPANTS
    },

    /** Ask a friend onto this call (host only). False when it cannot take them. */
    invite(peerKey: string): boolean {
      const peer = norm(peerKey)
      const status = invitees.get(peer)
      if (!this.canInvite() || peer === me() || status === 'ringing' || status === 'joined' || !deps.mayRing(peer)) return false
      gone.delete(peer)
      roster.add(peer)
      invitees.set(peer, 'ringing')
      const members = ctx().members
      if (!members.includes(peer)) actor.send({ type: 'MEMBERS', members: [...members, peer] })
      void ask(peer)
      emit()
      return true
    },

    /** Everyone else on the call this side can show: joined, setting up, or (for the host) still ringing. */
    participants(): CallParticipant[] {
      const c = ctx()
      const out: CallParticipant[] = []
      for (const peer of c.members) {
        if (gone.has(peer)) continue
        const leg = legs.get(peer)
        const status: CallParticipant['status'] | null = c.joined.includes(peer)
          ? 'connected'
          : leg?.media || leg?.opening || invitees.get(peer) === 'joined' || (c.direction === 'in' && peer === c.peer)
            ? 'connecting'
            : invitees.get(peer) === 'ringing'
              ? 'ringing'
              : null
        if (!status) continue
        out.push({ peer, status, stream: leg?.remote ?? null, state: c.remote[peer] ?? QUIET, safety: leg?.safety ?? null })
      }
      return out
    },

    /** Whether `key` is on the call under way, so its direct session may open even if it is no friend. */
    inCall(key: string): boolean {
      return busy() && roster.has(norm(key)) && !gone.has(norm(key))
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
      if (ctx().callId !== frame.call) return true
      if (!roster.has(peer)) {
        if ((frame.t === 'sdp' || frame.t === 'ice') && accepted()) keepStray(peer, signalOf(frame))
        return true
      }
      switch (frame.t) {
        case 'accept':
          onAccept(peer)
          break
        case 'decline':
          drop(peer, frame.reason === 'busy' ? 'busy' : 'declined')
          break
        case 'hangup':
          drop(peer, frame.reason === 'failed' ? 'failed' : 'declined')
          break
        case 'roster':
          onRoster(peer, frame.joined)
          break
        case 'state':
          actor.send({ type: 'REMOTE_STATE', peer, ...frame.state })
          break
        case 'sdp':
        case 'ice':
          onSignal(peer, signalOf(frame))
          break
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

    /** The other side's media on a two-person call (on a group call, the host's or the first to connect). */
    remoteStream(): MediaStream | null {
      const peer = ctx().peer
      return (peer ? legs.get(peer)?.remote : null) ?? liveLegs().find((leg) => leg.remote)?.remote ?? null
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
