/**
 * In-memory media for call tests: tracks, streams, and an RTCPeerConnection
 * that negotiates like a browser's (implicit offer/answer, implicit rollback,
 * trickled candidates) and connects two fakes that applied each other's
 * descriptions, matched by DTLS fingerprint. A connected pair hands each
 * other's sent tracks over as `track` events, again after renegotiation.
 */

type Listener = (event: any) => void

let counter = 0
const registry = new Map<string, FakeMediaConnection>()

export class FakeTrack {
  readonly id = `track-${++counter}`
  enabled = true
  readyState: 'live' | 'ended' = 'live'
  label: string
  constructor(
    readonly kind: 'audio' | 'video',
    label = `${kind} ${counter}`,
    private readonly settings: Record<string, unknown> = {},
  ) {
    this.label = label
  }
  stop(): void {
    this.readyState = 'ended'
  }
  getSettings(): Record<string, unknown> {
    return this.settings
  }
  private readonly listeners = new Map<string, Set<() => void>>()
  addEventListener(type: string, fn: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(fn)
  }
  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn)
  }
  /** The source went away outside the app, as when the system's own "Stop sharing" is clicked. */
  end(): void {
    this.readyState = 'ended'
    for (const fn of this.listeners.get('ended') ?? []) fn()
  }
}

export class FakeStream {
  readonly id = `stream-${++counter}`
  private tracks: FakeTrack[]
  constructor(tracks: FakeTrack[] = []) {
    this.tracks = [...tracks]
  }
  getTracks(): FakeTrack[] {
    return [...this.tracks]
  }
  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === 'audio')
  }
  getVideoTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === 'video')
  }
  addTrack(track: FakeTrack): void {
    if (!this.tracks.includes(track)) this.tracks.push(track)
  }
  removeTrack(track: FakeTrack): void {
    this.tracks = this.tracks.filter((t) => t !== track)
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

export function asStream(s: FakeStream): MediaStream {
  return s as unknown as MediaStream
}

function askedDevice(c: boolean | MediaTrackConstraints | undefined, fallback: string): string {
  const id = typeof c === 'object' ? c.deviceId : undefined
  if (typeof id === 'string') return id
  if (id && typeof id === 'object' && !Array.isArray(id)) {
    const v = (id as ConstrainDOMStringParameters).exact ?? (id as ConstrainDOMStringParameters).ideal
    if (typeof v === 'string') return v
  }
  return fallback
}

/**
 * A getUserMedia stand-in: an audio and/or video track as asked, each
 * reporting the device it was asked for, or `refuse` (or `refuseVideo` for
 * the camera alone) thrown.
 */
export function fakeGetUserMedia(opts: { refuse?: string; refuseVideo?: string; made?: FakeStream[] } = {}) {
  return async (constraints: MediaStreamConstraints): Promise<MediaStream> => {
    const refusal = opts.refuse ?? (constraints.video ? opts.refuseVideo : undefined)
    if (refusal) {
      const err = new Error('refused')
      err.name = refusal
      throw err
    }
    const tracks: FakeTrack[] = []
    if (constraints.audio) tracks.push(new FakeTrack('audio', undefined, { deviceId: askedDevice(constraints.audio, 'mic-default') }))
    if (constraints.video) tracks.push(new FakeTrack('video', undefined, { deviceId: askedDevice(constraints.video, 'cam-default') }))
    // `made` keeps what was opened, apart from the stream the caller may later add to or take from.
    opts.made?.push(new FakeStream(tracks))
    return asStream(new FakeStream(tracks))
  }
}

class FakeSender {
  constructor(
    public track: FakeTrack | null,
    readonly stream: FakeStream,
  ) {}
  async replaceTrack(track: FakeTrack | null): Promise<void> {
    this.track = track
  }
  params: { encodings: { maxBitrate?: number }[] } = { encodings: [{}] }
  getParameters(): { encodings: { maxBitrate?: number }[] } {
    return structuredClone(this.params)
  }
  async setParameters(params: { encodings: { maxBitrate?: number }[] }): Promise<void> {
    this.params = structuredClone(params)
  }
}

function fingerprintOf(sdp: string | undefined): string {
  return sdp?.match(/a=fingerprint:sha-256 (\S+)/)?.[1] ?? ''
}

export class FakeMediaConnection {
  private listeners = new Map<string, Set<Listener>>()
  readonly fingerprint: string
  localDescription: RTCSessionDescriptionInit | null = null
  remoteDescription: RTCSessionDescriptionInit | null = null
  signalingState: RTCSignalingState = 'stable'
  connectionState: RTCPeerConnectionState = 'new'
  readonly senders: FakeSender[] = []
  readonly candidates: RTCIceCandidateInit[] = []
  private delivered = new Set<FakeTrack>()
  /** One receiver per far sender, kept across replaced tracks as a transceiver's is. */
  readonly receivers = new Map<FakeSender, { track: FakeTrack }>()
  private negotiationQueued = false
  private generation = 0
  closed = false

  constructor(readonly config?: RTCConfiguration) {
    const n = ++counter
    this.fingerprint = Array.from({ length: 32 }, (_, i) => ((n * 7 + i * 13) % 256).toString(16).padStart(2, '0'))
      .join(':')
      .toUpperCase()
    registry.set(this.fingerprint, this)
  }

  addEventListener(type: string, listener: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(listener)
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener)
  }

  private emit(type: string, event: unknown = {}): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
  }

  private queueNegotiation(): void {
    if (this.negotiationQueued || this.closed) return
    this.negotiationQueued = true
    queueMicrotask(() => {
      this.negotiationQueued = false
      if (this.signalingState === 'stable' && !this.closed) this.emit('negotiationneeded')
    })
  }

  addTrack(track: FakeTrack, stream: FakeStream): FakeSender {
    const sender = new FakeSender(track, stream)
    this.senders.push(sender)
    // Added while answering, the track rides the answer, as in a browser.
    if (this.signalingState !== 'have-remote-offer') this.queueNegotiation()
    return sender
  }

  removeTrack(sender: FakeSender): void {
    sender.track = null
    this.queueNegotiation()
  }

  getSenders(): FakeSender[] {
    return [...this.senders]
  }

  private sdp(): string {
    this.generation += 1
    return [
      'v=0',
      `o=- 1 ${this.generation} IN IP4 127.0.0.1`,
      's=-',
      `a=fingerprint:sha-256 ${this.fingerprint}`,
      ...this.senders.filter((s) => s.track).map((s) => `m=${s.track!.kind} 9 UDP/TLS/RTP/SAVPF 111\r\na=msid:${s.stream.id} ${s.track!.id}`),
      '',
    ].join('\r\n')
  }

  async setLocalDescription(description?: RTCSessionDescriptionInit): Promise<void> {
    if (this.closed) throw new Error('closed')
    if (description?.type === 'rollback') {
      this.localDescription = null
      this.signalingState = 'stable'
      return
    }
    const type = description?.type ?? (this.signalingState === 'have-remote-offer' ? 'answer' : 'offer')
    this.localDescription = { type, sdp: description?.sdp ?? this.sdp() }
    this.signalingState = type === 'offer' ? 'have-local-offer' : 'stable'
    queueMicrotask(() => {
      if (this.closed) return
      const candidate = { candidate: `candidate:1 1 udp 2122260223 192.0.2.${counter % 250} 50000 typ host`, sdpMid: '0', sdpMLineIndex: 0 }
      this.emit('icecandidate', { candidate: { ...candidate, toJSON: () => candidate } })
      this.emit('icecandidate', { candidate: null })
    })
    if (this.signalingState === 'stable') this.settle()
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    if (this.closed) throw new Error('closed')
    if (description.type === 'offer') {
      if (this.signalingState === 'have-local-offer') this.localDescription = null
      this.remoteDescription = description
      this.signalingState = 'have-remote-offer'
      return
    }
    if (this.signalingState !== 'have-local-offer') throw new Error(`answer in ${this.signalingState}`)
    this.remoteDescription = description
    this.signalingState = 'stable'
    this.settle()
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.remoteDescription) throw new Error('no remote description')
    this.candidates.push(candidate)
  }

  /** The fake on the other end, once each holds the other's description. */
  partner(): FakeMediaConnection | undefined {
    const other = registry.get(fingerprintOf(this.remoteDescription?.sdp))
    if (!other || other.closed) return undefined
    return fingerprintOf(other.remoteDescription?.sdp) === this.fingerprint ? other : undefined
  }

  private settle(): void {
    queueMicrotask(() => {
      const other = this.partner()
      if (!other || this.closed) return
      for (const pc of [this, other]) {
        if (pc.connectionState !== 'connected') {
          pc.connectionState = 'connected'
          pc.emit('connectionstatechange')
        }
      }
      this.handOver(other)
      other.handOver(this)
    })
  }

  /** Give this side every track `from` sends that it has not had yet. */
  private handOver(from: FakeMediaConnection): void {
    for (const sender of from.senders) {
      if (!sender.track || this.delivered.has(sender.track)) continue
      this.delivered.add(sender.track)
      if (!this.receivers.has(sender)) this.receivers.set(sender, { track: sender.track })
      const receiver = this.receivers.get(sender)!
      receiver.track = sender.track
      this.emit('track', { track: sender.track, streams: [sender.stream], receiver })
    }
  }

  /** Simulate the network dropping. */
  fail(): void {
    this.connectionState = 'failed'
    this.emit('connectionstatechange')
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    registry.delete(this.fingerprint)
    this.connectionState = 'closed'
    this.signalingState = 'closed'
  }
}

/** An RTCPeerConnection constructor whose instances land in `created`. */
export function fakeMediaRtc(created: FakeMediaConnection[] = []): typeof RTCPeerConnection {
  return class extends FakeMediaConnection {
    constructor(config?: RTCConfiguration) {
      super(config)
      created.push(this)
    }
  } as unknown as typeof RTCPeerConnection
}
