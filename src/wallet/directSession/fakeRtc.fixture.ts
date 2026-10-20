/**
 * In-memory stand-in for RTCPeerConnection, enough for `@bsv/webrtpay`'s
 * `PeerLink`. Two fakes connect when each has applied the other's
 * description, matched by DTLS fingerprint, which is what the identity
 * handshake binds. The answerer receives the offerer's channel through a
 * `datachannel` event, as in a browser.
 */

type Listener = (event: any) => void

const registry = new Map<string, FakePeerConnection>()
let counter = 0

export function fakeSdp(fingerprint: string, extra: string[] = []): string {
  return [
    'v=0',
    'o=- 1 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    'a=ice-ufrag:fake',
    'a=ice-pwd:fakefakefakefakefakefake',
    `a=fingerprint:sha-256 ${fingerprint}`,
    'a=setup:actpass',
    'a=mid:0',
    'a=sctp-port:5000',
    'a=candidate:1 1 udp 2122260223 192.0.2.1 50000 typ host',
    ...extra,
    '',
  ].join('\r\n')
}

function fingerprintOf(sdp: string): string {
  return sdp.match(/a=fingerprint:sha-256 (\S+)/)?.[1] ?? ''
}

class Events {
  private listeners = new Map<string, Set<Listener>>()

  addEventListener(type: string, listener: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(listener)
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener)
  }

  protected emit(type: string, event: unknown = {}): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
  }
}

export class FakeDataChannel extends Events {
  readyState: RTCDataChannelState = 'connecting'
  readonly ordered = true
  readonly maxRetransmits = null
  readonly maxPacketLifeTime = null
  binaryType = 'blob'
  bufferedAmount = 0
  bufferedAmountLowThreshold = 0
  partner: FakeDataChannel | null = null
  /** Swallow outgoing frames, as a stalled path would. */
  mute = false

  constructor(readonly label: string) {
    super()
  }

  send(data: Uint8Array | string): void {
    if (this.readyState !== 'open') throw new Error('channel not open')
    if (this.mute) return
    const partner = this.partner
    const copy = typeof data === 'string' ? data : data.slice()
    queueMicrotask(() => {
      if (partner?.readyState === 'open') partner.emit('message', { data: copy })
    })
  }

  open(): void {
    if (this.readyState !== 'connecting') return
    this.readyState = 'open'
    this.emit('open')
  }

  close(): void {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    this.emit('close')
    this.partner?.close()
  }
}

export class FakePeerConnection extends Events {
  readonly fingerprint: string
  channel: FakeDataChannel | null = null
  localDescription: RTCSessionDescriptionInit | null = null
  remoteDescription: RTCSessionDescriptionInit | null = null
  iceGatheringState: RTCIceGatheringState = 'new'
  connectionState: RTCPeerConnectionState = 'new'
  signalingState: RTCSignalingState = 'stable'
  closed = false

  constructor() {
    super()
    counter += 1
    this.fingerprint = Array.from({ length: 32 }, (_, i) => ((counter * 7 + i) & 255).toString(16).padStart(2, '0').toUpperCase()).join(':')
    registry.set(this.fingerprint, this)
  }

  createDataChannel(label: string): FakeDataChannel {
    this.channel = new FakeDataChannel(label)
    return this.channel
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: fakeSdp(this.fingerprint) }
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: fakeSdp(this.fingerprint) }
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description
    queueMicrotask(() => {
      this.iceGatheringState = 'complete'
      this.emit('icegatheringstatechange')
    })
    this.tryConnect()
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    if (this.closed) throw new Error('closed')
    this.remoteDescription = description
    this.tryConnect()
  }

  private tryConnect(): void {
    if (!this.localDescription || !this.remoteDescription) return
    const other = registry.get(fingerprintOf(this.remoteDescription.sdp ?? ''))
    if (!other || other.closed || !other.localDescription || !other.remoteDescription) return
    if (fingerprintOf(other.remoteDescription.sdp ?? '') !== this.fingerprint) return
    const offerer = this.channel ? this : other
    const answerer = offerer === this ? other : this
    const offered = offerer.channel!
    const taken = new FakeDataChannel(offered.label)
    answerer.channel = taken
    offered.partner = taken
    taken.partner = offered
    for (const pc of [offerer, answerer]) {
      pc.connectionState = 'connected'
      pc.emit('connectionstatechange')
    }
    queueMicrotask(() => {
      answerer.emit('datachannel', { channel: taken })
      offered.open()
      taken.open()
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    registry.delete(this.fingerprint)
    this.connectionState = 'closed'
    this.signalingState = 'closed'
    this.channel?.close()
    this.emit('connectionstatechange')
  }
}

/** An RTCPeerConnection constructor whose instances land in `created`. */
export function fakeRtc(created: FakePeerConnection[] = []): typeof RTCPeerConnection {
  return class extends FakePeerConnection {
    constructor() {
      super()
      created.push(this)
    }
  } as unknown as typeof RTCPeerConnection
}
