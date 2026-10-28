/**
 * One media leg of a call: an RTCPeerConnection to one peer, negotiated over
 * the call frames with the "perfect negotiation" pattern, so either side may
 * add or drop a track at any time and a collision resolves itself (the callee
 * is the polite side and yields). Media is DTLS-SRTP end to end, and with
 * `frames` each encoded frame is sealed again under the call's identity-bound
 * keys; the only servers are STUN, and TURN when one is configured, which
 * relays ciphertext.
 */

import type { FrameProtector } from './frameProtector'

export type MediaRtcConstructor = typeof RTCPeerConnection

export type MediaSignal =
  | { kind: 'sdp'; description: { type: 'offer' | 'answer'; sdp: string } }
  | { kind: 'ice'; candidate: RTCIceCandidateInit }

export type MediaPeerOptions = {
  rtc: MediaRtcConstructor
  iceServers: RTCIceServer[]
  /** The callee: on a collision it drops its own offer and takes the other's. */
  polite: boolean
  send: (signal: MediaSignal) => void
  onTrack: (track: MediaStreamTrack, stream: MediaStream | undefined) => void
  onState: (state: RTCPeerConnectionState) => void
  /**
   * Runs once, between taking the first remote offer and answering it: the
   * callee adds its tracks here so they ride the caller's transceivers
   * instead of starting a second, colliding offer.
   */
  beforeAnswer?: () => void
  /** Seals what this side sends and opens what it receives; every sender and receiver passes through it once. */
  frames?: Pick<FrameProtector, 'config' | 'sender' | 'receiver'>
  log?: (what: string, err?: unknown) => void
}

export type MediaPeer = ReturnType<typeof createMediaPeer>

/** The `a=fingerprint` of a description, lower-cased, or '' when it has none. */
export function sdpFingerprint(sdp: string | undefined | null): string {
  return sdp?.match(/a=fingerprint:sha-256 ([0-9A-Fa-f:]+)/)?.[1]?.toLowerCase() ?? ''
}

export function createMediaPeer(opts: MediaPeerOptions) {
  const log = opts.log ?? (() => undefined)
  const pc = new opts.rtc({ iceServers: opts.iceServers, ...opts.frames?.config } as RTCConfiguration)
  const protectedEnds = new WeakSet<object>()
  let makingOffer = false
  let ignoreOffer = false
  let closed = false
  let beforeAnswer = opts.beforeAnswer
  const early: RTCIceCandidateInit[] = []

  function sendLocal(): void {
    const d = pc.localDescription
    if (!d?.sdp || (d.type !== 'offer' && d.type !== 'answer')) return
    opts.send({ kind: 'sdp', description: { type: d.type, sdp: d.sdp } })
  }

  pc.addEventListener('negotiationneeded', async () => {
    if (closed) return
    try {
      makingOffer = true
      await pc.setLocalDescription()
      sendLocal()
    } catch (err) {
      log('offer failed', err)
    } finally {
      makingOffer = false
    }
  })

  pc.addEventListener('icecandidate', (event: RTCPeerConnectionIceEvent) => {
    const c = event.candidate
    if (!c || closed) return
    const init = typeof c.toJSON === 'function' ? c.toJSON() : (c as unknown as RTCIceCandidateInit)
    if (init.candidate) opts.send({ kind: 'ice', candidate: init })
  })

  pc.addEventListener('track', (event: RTCTrackEvent) => {
    if (closed) return
    if (opts.frames && event.receiver && !protectedEnds.has(event.receiver)) {
      protectedEnds.add(event.receiver)
      opts.frames.receiver(event.receiver)
    }
    opts.onTrack(event.track, event.streams?.[0])
  })

  pc.addEventListener('connectionstatechange', () => {
    if (!closed) opts.onState(pc.connectionState)
  })

  async function flushEarly(): Promise<void> {
    while (early.length && pc.remoteDescription) {
      const c = early.shift()!
      await pc.addIceCandidate(c).catch((err) => log('candidate refused', err))
    }
  }

  return {
    get connection(): RTCPeerConnection {
      return pc
    },

    addTrack(track: MediaStreamTrack, stream: MediaStream): RTCRtpSender {
      const sender = pc.addTrack(track, stream)
      if (opts.frames && !protectedEnds.has(sender)) {
        protectedEnds.add(sender)
        opts.frames.sender(sender, pc)
      }
      return sender
    },

    async handle(signal: MediaSignal): Promise<void> {
      if (closed) return
      if (signal.kind === 'ice') {
        if (!pc.remoteDescription) {
          early.push(signal.candidate)
          return
        }
        try {
          await pc.addIceCandidate(signal.candidate)
        } catch (err) {
          if (!ignoreOffer) log('candidate refused', err)
        }
        return
      }
      const d = signal.description
      const collision = d.type === 'offer' && (makingOffer || pc.signalingState !== 'stable')
      ignoreOffer = !opts.polite && collision
      if (ignoreOffer) return
      try {
        await pc.setRemoteDescription(d)
        await flushEarly()
        if (d.type === 'offer') {
          const ready = beforeAnswer
          beforeAnswer = undefined
          ready?.()
          await pc.setLocalDescription()
          sendLocal()
        }
      } catch (err) {
        log('description refused', err)
      }
    },

    localFingerprint(): string {
      return sdpFingerprint(pc.localDescription?.sdp)
    },

    remoteFingerprint(): string {
      return sdpFingerprint(pc.remoteDescription?.sdp)
    },

    close(): void {
      if (closed) return
      closed = true
      try {
        pc.close()
      } catch {
        /* already closed */
      }
    },
  }
}
