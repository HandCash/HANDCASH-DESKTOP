/**
 * In-memory stand-in for RTCPeerConnection. Two fakes connect when each has
 * applied the other's description, matched by DTLS fingerprint, which is what
 * the signed session description binds.
 */

type Listener = () => void

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

export class FakeDataChannel {
  readyState: RTCDataChannelState = 'connecting'
  partner: FakeDataChannel | null = null
  /** Swallow outgoing frames, as a stalled path would. */
  mute = false
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null

  send(data: string): void {
    if (this.readyState !== 'open') throw new Error('channel not open')
    if (this.mute) return
    const partner = this.partner
    queueMicrotask(() => partner?.onmessage?.({ data }))
  }

  open(): void {
    this.readyState = 'open'
    this.onopen?.()
  }

  close(): void {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    this.onclose?.()
    this.partner?.close()
  }
}

export class FakePeerConnection {
  readonly fingerprint: string
  readonly channel = new FakeDataChannel()
  localDescription: RTCSessionDescriptionInit | null = null
  remoteDescription: RTCSessionDescriptionInit | null = null
  iceGatheringState: RTCIceGatheringState = 'new'
  connectionState: RTCPeerConnectionState = 'new'
  sctp = { maxMessageSize: 262_144 }
  closed = false
  private listeners = new Map<string, Set<Listener>>()

  constructor() {
    counter += 1
    this.fingerprint = Array.from({ length: 32 }, (_, i) => ((counter * 7 + i) & 255).toString(16).padStart(2, '0').toUpperCase()).join(':')
    registry.set(this.fingerprint, this)
  }

  addEventListener(type: string, listener: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(listener)
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener)
  }

  private emit(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener()
  }

  createDataChannel(): FakeDataChannel {
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
    this.remoteDescription = description
    this.tryConnect()
  }

  private tryConnect(): void {
    if (!this.localDescription || !this.remoteDescription) return
    const other = registry.get(fingerprintOf(this.remoteDescription.sdp ?? ''))
    if (!other || other.closed || !other.localDescription || !other.remoteDescription) return
    if (fingerprintOf(other.remoteDescription.sdp ?? '') !== this.fingerprint) return
    this.channel.partner = other.channel
    other.channel.partner = this.channel
    for (const pc of [this, other]) {
      pc.connectionState = 'connected'
      pc.emit('connectionstatechange')
    }
    queueMicrotask(() => {
      this.channel.open()
      other.channel.open()
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    registry.delete(this.fingerprint)
    this.connectionState = 'closed'
    this.channel.close()
    this.emit('connectionstatechange')
  }
}

export function fakeRtcFactory(created: FakePeerConnection[] = []) {
  return () => {
    const pc = new FakePeerConnection()
    created.push(pc)
    return pc as unknown as RTCPeerConnection
  }
}
