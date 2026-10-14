/**
 * Hot-path session table (draft BRC-246 v2). The messagebox remains the
 * rendezvous and the offline inbox. A message goes direct only on an open,
 * authenticated data channel and falls back to the box when it is not acked.
 *
 * A table is bound to one local identity. Chat uses the module-level table
 * (the active account); the link between installs of one vault
 * (`vaultLink.ts`) has its own, so neither answers the other's offers.
 */

import {
  SESSION_ACK_MS,
  SESSION_CHANNEL_LABEL,
  SESSION_GATHER_MS,
  SESSION_IDLE_MS,
  SESSION_MAX_BODY,
  SESSION_OFFER_REPEAT_MS,
  SESSION_SKEW_MS,
  acceptableSessionSdp,
  decodeSessionSignal,
  encodeSessionSignal,
  keepsOwnOfferOnGlare,
  signSessionSignal,
  verifySessionAnswer,
  verifySessionOffer,
  type SessionSignal,
} from './protocol'

export type RtcFactory = (config: RTCConfiguration) => RTCPeerConnection
/** Seal `body` to `to` and post it to `to`'s signalling box. */
export type SignalSender = (to: string, body: string) => Promise<void>
/** Whether to answer an offer from this identity. */
export type OfferPolicy = (identityKey: string) => boolean
/** `not-mine` is addressed to another install of this identity: leave it unacknowledged. */
export type SignalDisposition = 'handled' | 'not-mine' | 'invalid'
/** `device` is the sending install, as its signed offer or answer named it. */
export type InboundHandler = (sender: string, body: string, device: string) => void

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
]

type Live = {
  peer: string
  device: string
  pc: RTCPeerConnection
  channel: RTCDataChannel
  acks: Map<string, (ok: boolean) => void>
  idle: ReturnType<typeof setTimeout> | null
}

type Pending = {
  offer: SessionSignal
  pc: RTCPeerConnection
  channel: RTCDataChannel
  timer: ReturnType<typeof setTimeout>
}

function norm(key: string): string {
  return key.trim().toLowerCase()
}

function endpointKey(identity: string, device: string): string {
  return `${norm(identity)}\n${device}`
}

function closeQuietly(pc: RTCPeerConnection): void {
  try {
    pc.close()
  } catch {
    /* already closed */
  }
}

function messageId(): string {
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('')
}

function gathered(pc: RTCPeerConnection): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve()
    const timer = setTimeout(done, SESSION_GATHER_MS)
    function done() {
      clearTimeout(timer)
      pc.removeEventListener('icegatheringstatechange', check)
      resolve()
    }
    function check() {
      if (pc.iceGatheringState === 'complete') done()
    }
    pc.addEventListener('icegatheringstatechange', check)
  })
}

function frameBytes(frame: string): number {
  return new TextEncoder().encode(frame).length
}

export type SessionTable = ReturnType<typeof createSessionTable>

export function createSessionTable(tag = 'direct-session') {
  let rtcFactory: RtcFactory | null =
    typeof globalThis.RTCPeerConnection === 'function'
      ? (config) => new globalThis.RTCPeerConnection(config)
      : null
  let sendSignal: SignalSender | null = null
  let offerPolicy: OfferPolicy = () => true
  let onInboundBody: InboundHandler | null = null
  let rootKeyHex = ''
  let localIdentity = ''
  let localDevice = ''
  const live = new Map<string, Live>()
  const pending = new Map<string, Pending>()
  const offerSentAt = new Map<string, number>()
  /** Offers already answered: a box read twice must not replace a live channel. */
  const answered = new Map<string, number>()

  function drop(key: string): void {
    const session = live.get(key)
    if (!session) return
    live.delete(key)
    if (session.idle) clearTimeout(session.idle)
    for (const resolve of session.acks.values()) resolve(false)
    closeQuietly(session.pc)
  }

  function abandon(target: string): void {
    const offer = pending.get(target)
    if (!offer) return
    pending.delete(target)
    clearTimeout(offer.timer)
    closeQuietly(offer.pc)
  }

  function reset(): void {
    for (const key of [...live.keys()]) drop(key)
    for (const target of [...pending.keys()]) abandon(target)
    offerSentAt.clear()
    answered.clear()
  }

  function openSession(identity: string, device?: string): Live | null {
    const peer = norm(identity)
    for (const session of live.values()) {
      if (session.peer !== peer || (device && session.device !== device)) continue
      if (session.channel.readyState === 'open') return session
    }
    return null
  }

  function touch(key: string, session: Live): void {
    if (session.idle) clearTimeout(session.idle)
    session.idle = setTimeout(() => drop(key), SESSION_IDLE_MS)
  }

  function adopt(peer: string, device: string, pc: RTCPeerConnection, channel: RTCDataChannel): void {
    const key = endpointKey(peer, device)
    drop(key)
    const session: Live = { peer: norm(peer), device, pc, channel, acks: new Map(), idle: null }
    live.set(key, session)
    touch(key, session)
    channel.onmessage = (event) => {
      if (live.get(key) !== session || typeof event.data !== 'string') return
      let frame: { t?: unknown; id?: unknown; body?: unknown }
      try {
        frame = JSON.parse(event.data) as typeof frame
      } catch {
        return
      }
      if (typeof frame.id !== 'string') return
      if (frame.t === 'ack') {
        session.acks.get(frame.id)?.(true)
        return
      }
      if (frame.t !== 'msg' || typeof frame.body !== 'string') return
      touch(key, session)
      onInboundBody?.(session.peer, frame.body, session.device)
      try {
        channel.send(JSON.stringify({ t: 'ack', id: frame.id }))
      } catch {
        drop(key)
      }
    }
    channel.onclose = () => {
      if (live.get(key) === session) drop(key)
    }
    pc.addEventListener('connectionstatechange', () => {
      if (live.get(key) === session && (pc.connectionState === 'failed' || pc.connectionState === 'closed')) drop(key)
    })
  }

  function newPeer(): { pc: RTCPeerConnection; channel: RTCDataChannel } | null {
    if (!rtcFactory) return null
    const pc = rtcFactory({ iceServers: ICE_SERVERS })
    const channel = pc.createDataChannel(SESSION_CHANNEL_LABEL, { negotiated: true, id: 0, ordered: true })
    return { pc, channel }
  }

  function ready(): boolean {
    return !!rtcFactory && !!sendSignal && !!rootKeyHex && !!localIdentity && !!localDevice
  }

  async function answer(offer: SessionSignal): Promise<void> {
    const created = newPeer()
    if (!created) return
    const { pc, channel } = created
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp })
      await pc.setLocalDescription(await pc.createAnswer())
      await gathered(pc)
      const sdp = pc.localDescription?.sdp ?? ''
      if (!acceptableSessionSdp(sdp)) throw new Error('unacceptable local description')
      const reply = signSessionSignal({
        rootKeyHex,
        t: 'answer',
        fromDevice: localDevice,
        to: offer.from,
        toDevice: offer.fromDevice,
        offerNonce: offer.nonce,
        sdp,
        expiresAt: offer.expiresAt,
      })
      adopt(offer.from, offer.fromDevice, pc, channel)
      await sendSignal!(offer.from, encodeSessionSignal(reply))
    } catch (err) {
      drop(endpointKey(offer.from, offer.fromDevice))
      closeQuietly(pc)
      console.info(`[${tag}] answer failed — ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return {
    installRtcFactory(next: RtcFactory | null): void {
      rtcFactory = next
    },

    installSignalSender(next: SignalSender | null): void {
      sendSignal = next
    },

    installOfferPolicy(next: OfferPolicy): void {
      offerPolicy = next
    },

    setInboundHandler(handler: InboundHandler | null): void {
      onInboundBody = handler
    },

    setIdentity(args: { rootKeyHex: string; identityKey: string; device?: string }): void {
      const identity = norm(args.identityKey)
      if (localIdentity && identity !== localIdentity) reset()
      rootKeyHex = args.rootKeyHex
      localIdentity = identity
      if (args.device) localDevice = args.device
    },

    reset,

    hasPendingOffers(): boolean {
      return pending.size > 0
    },

    hasSession(identity: string, device?: string): boolean {
      return !!openSession(identity, device)
    },

    /** Offer a session to `identity` (one install of it, when `device` is set). True when an offer went out. */
    async request(identity: string, device = '', now = Date.now()): Promise<boolean> {
      if (!ready()) return false
      const peer = norm(identity)
      if (peer === localIdentity && (!device || device === localDevice)) return false
      if (openSession(peer, device || undefined)) return false
      const target = endpointKey(peer, device)
      // An answered offer still connecting: a second offer would replace it on the far end.
      if (device && live.has(target)) return false
      if (pending.has(target)) return false
      if (now - (offerSentAt.get(target) ?? 0) < SESSION_OFFER_REPEAT_MS) return false
      offerSentAt.set(target, now)
      const created = newPeer()
      if (!created) return false
      const { pc, channel } = created
      try {
        await pc.setLocalDescription(await pc.createOffer())
        await gathered(pc)
        const sdp = pc.localDescription?.sdp ?? ''
        if (!acceptableSessionSdp(sdp)) throw new Error('unacceptable local description')
        const offer = signSessionSignal({ rootKeyHex, t: 'offer', fromDevice: localDevice, to: peer, toDevice: device, sdp, now })
        pending.set(target, {
          offer,
          pc,
          channel,
          timer: setTimeout(() => abandon(target), Math.max(0, offer.expiresAt - Date.now())),
        })
        await sendSignal!(peer, encodeSessionSignal(offer))
        return true
      } catch (err) {
        if (pending.get(target)?.pc === pc) abandon(target)
        else closeQuietly(pc)
        console.info(`[${tag}] offer failed — ${err instanceof Error ? err.message : String(err)}`)
        return false
      }
    },

    /** One decrypted body from the signalling box. */
    async ingest(body: string, now = Date.now()): Promise<SignalDisposition> {
      const signal = decodeSessionSignal(body)
      if (!signal || !localIdentity || !localDevice) return 'invalid'
      if (signal.expiresAt < now - SESSION_SKEW_MS) return 'invalid'
      if (signal.from === localIdentity && signal.fromDevice === localDevice) return 'not-mine'
      if (signal.toDevice && signal.toDevice !== localDevice) return 'not-mine'
      if (signal.to !== localIdentity || !ready()) return 'invalid'

      if (signal.t === 'answer') {
        const entry = [...pending.entries()].find(([, p]) => p.offer.nonce === signal.offerNonce)
        if (!entry) return 'invalid'
        const [target, offer] = entry
        if (!verifySessionAnswer(signal, { offer: offer.offer, now })) return 'invalid'
        pending.delete(target)
        clearTimeout(offer.timer)
        try {
          await offer.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp })
          adopt(signal.from, signal.fromDevice, offer.pc, offer.channel)
        } catch {
          closeQuietly(offer.pc)
        }
        return 'handled'
      }

      if (!verifySessionOffer(signal, { identityKey: localIdentity, device: localDevice, now })) return 'invalid'
      if (answered.has(signal.nonce)) return 'handled'
      for (const [nonce, expiresAt] of answered) if (expiresAt < now - SESSION_SKEW_MS) answered.delete(nonce)
      answered.set(signal.nonce, signal.expiresAt)
      if (signal.from !== localIdentity && !offerPolicy(signal.from)) return 'handled'
      const ours = [endpointKey(signal.from, signal.fromDevice), endpointKey(signal.from, '')].find(t => pending.has(t))
      if (ours) {
        const local = { identityKey: localIdentity, device: localDevice }
        if (keepsOwnOfferOnGlare(local, { identityKey: signal.from, device: signal.fromDevice })) return 'handled'
        abandon(ours)
      }
      await answer(signal)
      return 'handled'
    },

    /** Send on an open data channel, or report `box`. Never waits for a connection. */
    async deliver(args: { recipientIdentityKey: string; body: string; recipientDevice?: string }): Promise<'direct' | 'box'> {
      if (!args.body) return 'box'
      const session = openSession(args.recipientIdentityKey, args.recipientDevice)
      if (!session) return 'box'
      const key = endpointKey(session.peer, session.device)
      const id = messageId()
      const frame = JSON.stringify({ t: 'msg', id, body: args.body })
      const limit = Math.min(SESSION_MAX_BODY, session.pc.sctp?.maxMessageSize || SESSION_MAX_BODY)
      if (frameBytes(frame) > limit) return 'box'
      const acked = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => settle(false), SESSION_ACK_MS)
        function settle(ok: boolean) {
          clearTimeout(timer)
          session!.acks.delete(id)
          resolve(ok)
        }
        session.acks.set(id, settle)
        try {
          session.channel.send(frame)
        } catch {
          settle(false)
        }
      })
      if (acked) {
        touch(key, session)
        return 'direct'
      }
      drop(key)
      return 'box'
    },
  }
}

const chat = createSessionTable()

export const installRtcFactory = chat.installRtcFactory
export const installSignalSender = chat.installSignalSender
export const installOfferPolicy = chat.installOfferPolicy
export const setDirectInboundHandler = chat.setInboundHandler
export const setDirectSessionIdentity = chat.setIdentity
export const resetDirectSessions = chat.reset
export const hasPendingSessionOffers = chat.hasPendingOffers
export const hasDirectSession = chat.hasSession
export const requestDirectSession = chat.request
export const ingestSessionSignal = chat.ingest
export const tryDirectDeliver = chat.deliver
