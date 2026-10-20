/**
 * Direct session table (draft BRC-246 over `webrtpay/1`). The messagebox
 * remains the rendezvous and the offline inbox. A message goes direct only on
 * an open, authenticated session and falls back to the box when it is not
 * acked within a second.
 *
 * A table is bound to one local identity. Chat uses the module-level table
 * (the active account) on box `webrtpay_messages`; the link between installs
 * of one vault (`vaultLink.ts`) has its own on box `vault-link`, so neither
 * answers the other's dials.
 */

import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import {
  DEFAULTS,
  DEFAULT_INBOUND_LIMITS,
  InboundLimiter,
  PeerLink,
  ReplayCache,
  type RtcOptions,
} from '@bsv/webrtpay'
import {
  PRE_AUTH_MAX_BYTES,
  SESSION_MAX_MSG_BYTES,
  authenticateChannel,
  messageBytes,
  type MessageChannel,
  type SessionMessage,
} from './channel'
import {
  keepsOwnDialOnGlare,
  newSid,
  openMessageSignal,
  sealMessageSignal,
  type MessageSignal,
  type MessageSignalKind,
} from './signal'

export const SESSION_ACK_MS = 1_000
export const SESSION_IDLE_MS = 10 * 60_000
/** One dial per endpoint in this window, so a chat burst does not knock on every line. */
export const SESSION_DIAL_REPEAT_MS = 20_000
/**
 * `webrtpay/1`'s presence and dial windows assume a live carrier; a polled
 * one adds up to a poll interval of the peer's before it hears the signal.
 */
export const SESSION_PRESENCE_MS = DEFAULTS.presenceTimeoutMs + DEFAULTS.payeePollMs
export const SESSION_DIAL_MS = DEFAULTS.dialTimeoutMs + DEFAULTS.payeePollMs
const CONNECT_MS = DEFAULTS.connectTimeoutMs
const GATHER_MS = DEFAULTS.dialGatherTimeoutMs
const REJECT_GAP_MS = 1_000

export type RtcConstructor = typeof RTCPeerConnection
/** Post `body` (a signalling envelope as JSON) to `to`'s signalling box. */
export type SignalSender = (to: string, body: string) => Promise<void>
/** Whether to ring and answer a dial from this identity (own installs are always answered). */
export type OfferPolicy = (identityKey: string) => boolean
/** `not-mine` is addressed to another install of this identity: leave it unacknowledged. */
export type SignalDisposition = 'handled' | 'not-mine' | 'invalid'
/** `device` is the sending install, as its signals named it. */
export type InboundHandler = (sender: string, body: string, device: string) => void

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
]

type Live = {
  peer: string
  device: string
  channel: MessageChannel
  acks: Map<string, (ok: boolean) => void>
  idle: ReturnType<typeof setTimeout> | undefined
  /** Intake slot of an answered dial, released when the session ends. */
  slot?: string
}

type Dial = {
  sid: string
  peer: string
  /** Empty until a ring names the answering install, when the dial named none. */
  device: string
  phase: 'knocked' | 'offered' | 'connecting'
  /** Gathered from the knock on; sent once the peer rings. */
  offer: Promise<{ link: PeerLink; sdp: string } | null>
  timer?: ReturnType<typeof setTimeout>
  total?: ReturnType<typeof setTimeout>
  done: boolean
}

function norm(key: string): string {
  return key.trim().toLowerCase()
}

function endpointKey(identity: string, device: string): string {
  return `${norm(identity)}\n${device}`
}

function messageId(): string {
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('')
}

export function createSessionTable(tag = 'direct-session') {
  let rtc: RtcConstructor | null = null
  let sendSignal: SignalSender | null = null
  let offerPolicy: OfferPolicy = () => false
  let onInboundBody: InboundHandler | null = null
  let wallet: ProtoWallet | null = null
  let localIdentity = ''
  let localDevice = ''
  let chain: string | undefined
  let replay = new ReplayCache()
  let limiter = new InboundLimiter({ ...DEFAULT_INBOUND_LIMITS, maxConcurrent: 16 })
  let rejectedAt = 0
  const live = new Map<string, Live>()
  const dials = new Map<string, Dial>()
  /** Answered dials still connecting, by endpoint. */
  const answering = new Map<string, PeerLink>()
  const dialedAt = new Map<string, number>()

  function rtcConstructor(): RtcConstructor | undefined {
    return rtc ?? (globalThis as { RTCPeerConnection?: RtcConstructor }).RTCPeerConnection
  }

  function ready(): boolean {
    return !!wallet && !!localIdentity && !!localDevice && !!sendSignal && !!rtcConstructor()
  }

  function rtcOptions(): RtcOptions & { maxMessageBytes: number } {
    return {
      RTCPeerConnection: rtcConstructor(),
      iceServers: ICE_SERVERS,
      gatherTimeoutMs: GATHER_MS,
      maxMessageBytes: PRE_AUTH_MAX_BYTES,
    }
  }

  function log(what: string, err?: unknown): void {
    console.info(`[${tag}] ${what}${err === undefined ? '' : ` — ${err instanceof Error ? err.message : String(err)}`}`)
  }

  async function post(
    to: string,
    p: { kind: MessageSignalKind; sid: string; toDevice: string; sdp?: string; reason?: string },
  ): Promise<void> {
    const envelope = await sealMessageSignal(wallet!, {
      ...p,
      from: localIdentity,
      to,
      ts: Date.now(),
      fromDevice: localDevice,
      ...(chain ? { chain } : {}),
    })
    await sendSignal!(to, JSON.stringify(envelope))
  }

  function openSession(identity: string, device?: string): Live | undefined {
    const peer = norm(identity)
    if (device) {
      const session = live.get(endpointKey(peer, device))
      return session?.channel.isOpen ? session : undefined
    }
    for (const session of live.values()) {
      if (session.peer === peer && session.channel.isOpen) return session
    }
    return undefined
  }

  function touch(key: string, session: Live): void {
    clearTimeout(session.idle)
    session.idle = setTimeout(() => drop(key, session), SESSION_IDLE_MS)
  }

  /** End a session in order (`bye`) and forget it. */
  function drop(key: string, session: Live): void {
    if (live.get(key) === session) live.delete(key)
    clearTimeout(session.idle)
    for (const settle of [...session.acks.values()]) settle(false)
    if (session.slot) limiter.release(session.slot)
    session.channel.bye()
  }

  function adopt(peer: string, device: string, channel: MessageChannel, slot?: string): void {
    const key = endpointKey(peer, device)
    const old = live.get(key)
    if (old) drop(key, old)
    const session: Live = { peer, device, channel, acks: new Map(), idle: undefined, slot }
    live.set(key, session)
    channel.onMessage((m) => receive(key, session, m))
    channel.onClose(() => {
      if (live.get(key) === session) drop(key, session)
    })
    touch(key, session)
  }

  function receive(key: string, session: Live, m: SessionMessage): void {
    if (m.t === 'ack') {
      session.acks.get(m.id)?.(true)
      return
    }
    if (m.t === 'error' || m.t === 'bye') {
      drop(key, session)
      return
    }
    touch(key, session)
    try {
      onInboundBody?.(session.peer, m.body, session.device)
    } catch (err) {
      log('inbound body failed', err)
      return
    }
    session.channel.send({ t: 'ack', id: m.id }).catch(() => undefined)
  }

  /** Forget a dial; its link closes unless the dial connected (`keepLink`). */
  function endDial(dial: Dial, why?: string, keepLink = false): void {
    if (dial.done) return
    dial.done = true
    clearTimeout(dial.timer)
    clearTimeout(dial.total)
    for (const [key, d] of dials) if (d === dial) dials.delete(key)
    if (!keepLink) void dial.offer.then((made) => made?.link.close())
    if (why) log(`dial ended: ${why}`)
  }

  function dialFor(s: MessageSignal): Dial | undefined {
    for (const dial of dials.values()) {
      if (dial.sid === s.sid && dial.peer === s.from && (!dial.device || dial.device === s.fromDevice)) return dial
    }
    return undefined
  }

  function wanted(s: MessageSignal): boolean {
    if (s.kind === 'knock' || s.kind === 'offer') return true
    const dial = dialFor(s)
    if (!dial || dial.done) return false
    if (s.kind === 'ring') return dial.phase === 'knocked'
    if (s.kind === 'answer') return dial.phase === 'offered'
    return true
  }

  async function onRing(dial: Dial, s: MessageSignal): Promise<void> {
    clearTimeout(dial.timer)
    dial.device ||= s.fromDevice
    dial.timer = setTimeout(() => endDial(dial, 'timeout'), SESSION_DIAL_MS)
    dial.phase = 'offered'
    const made = await dial.offer
    if (dial.done) return
    if (!made) return endDial(dial, 'no local offer')
    try {
      await post(dial.peer, { kind: 'offer', sid: dial.sid, toDevice: dial.device, sdp: made.sdp })
    } catch (err) {
      endDial(dial)
      log('offer not posted', err)
    }
  }

  async function onAnswer(dial: Dial, s: MessageSignal): Promise<void> {
    const link = (await dial.offer)?.link
    if (dial.done) return
    if (!link || !s.sdp) return endDial(dial, 'answer without a description')
    if (chain && s.chain !== chain) return endDial(dial, 'rejected: wrong_network')
    try {
      await link.acceptAnswer(s.sdp)
    } catch (err) {
      endDial(dial)
      log('answer refused', err)
      return
    }
    if (dial.done) return
    dial.phase = 'connecting'
    authenticateChannel(link, { wallet: wallet!, expectedPeer: dial.peer, timeoutMs: SESSION_DIAL_MS }).then(
      (channel) => {
        if (dial.done) return channel.close()
        endDial(dial, undefined, true)
        adopt(dial.peer, dial.device, channel)
      },
      (err) => {
        endDial(dial)
        log('handshake failed', err)
      },
    )
  }

  /** Whether to take a knock or offer from `s.from`; replies with a reject when it should. */
  async function admissible(s: MessageSignal): Promise<boolean> {
    if (!ready()) return false
    if (s.from !== localIdentity && !offerPolicy(s.from)) return false
    if (chain && s.chain !== chain) {
      await reject(s, 'wrong_network')
      return false
    }
    const mine = dials.get(endpointKey(s.from, s.fromDevice)) ?? dials.get(endpointKey(s.from, ''))
    if (mine && !mine.done) {
      if (keepsOwnDialOnGlare({ identityKey: localIdentity, device: localDevice }, { identityKey: s.from, device: s.fromDevice })) {
        return false
      }
      endDial(mine)
    }
    return true
  }

  async function reject(s: MessageSignal, reason: string): Promise<void> {
    const now = Date.now()
    if (now - rejectedAt < REJECT_GAP_MS) return
    rejectedAt = now
    await post(s.from, { kind: 'reject', sid: s.sid, toDevice: s.fromDevice, reason }).catch(() => undefined)
  }

  async function onKnock(s: MessageSignal): Promise<void> {
    if (!(await admissible(s))) return
    const slot = endpointKey(s.from, s.fromDevice)
    const refusal = limiter.refusal(slot, undefined, { superseding: live.has(slot) })
    if (refusal === 'busy') return reject(s, 'busy')
    if (refusal) return
    await post(s.from, { kind: 'ring', sid: s.sid, toDevice: s.fromDevice }).catch((err) => log('ring not posted', err))
  }

  async function onOffer(s: MessageSignal): Promise<void> {
    if (!s.sdp || !(await admissible(s))) return
    const slot = endpointKey(s.from, s.fromDevice)
    if (answering.has(slot)) return
    const old = live.get(slot)
    if (old) drop(slot, old)
    if (!limiter.tryAdmit(slot)) {
      if (limiter.refusal(slot) === 'busy') await reject(s, 'busy')
      return
    }
    let link: PeerLink | undefined
    try {
      const made = await PeerLink.acceptOffer(s.sdp, rtcOptions())
      link = made.link
      answering.set(slot, link)
      const sent = post(s.from, { kind: 'answer', sid: s.sid, toDevice: s.fromDevice, sdp: made.sdp })
      const handshake = authenticateChannel(link, { wallet: wallet!, expectedPeer: s.from, timeoutMs: CONNECT_MS, startAfter: sent })
      await sent
      handshake.then(
        (channel) => {
          if (answering.get(slot) !== link) {
            channel.close()
            limiter.release(slot)
            return
          }
          answering.delete(slot)
          adopt(s.from, s.fromDevice, channel, slot)
        },
        (err) => {
          if (answering.get(slot) === link) answering.delete(slot)
          limiter.release(slot)
          log('handshake failed', err)
        },
      )
    } catch (err) {
      if (link && answering.get(slot) === link) answering.delete(slot)
      link?.close()
      limiter.release(slot)
      log('answer failed', err)
    }
  }

  function reset(): void {
    for (const [key, session] of [...live]) drop(key, session)
    for (const dial of [...dials.values()]) endDial(dial)
    for (const link of answering.values()) link.close()
    answering.clear()
    dialedAt.clear()
    replay = new ReplayCache()
    limiter = new InboundLimiter({ ...DEFAULT_INBOUND_LIMITS, maxConcurrent: 16 })
  }

  return {
    installRtc(next: RtcConstructor | null): void {
      rtc = next
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

    /** Bind to an identity; another identity, or a lock, ends every session first. */
    setIdentity(args: { rootKeyHex: string; identityKey: string; device?: string; chain?: string }): void {
      const identity = norm(args.identityKey)
      if (localIdentity && identity !== localIdentity) {
        reset()
        chain = undefined
      }
      wallet = new ProtoWallet(PrivateKey.fromHex(args.rootKeyHex.trim()))
      localIdentity = identity
      if (args.device) localDevice = args.device
      if (args.chain) chain = args.chain
    },

    reset,

    /** A dial waits on the box: read it at the dialling cadence. */
    hasActiveDials(): boolean {
      return dials.size > 0
    },

    hasSession(identity: string, device?: string): boolean {
      return !!openSession(identity, device)
    },

    /** Dial `identity` (one install of it, when `device` is set). True when a knock went out. */
    async request(identity: string, device = '', now = Date.now()): Promise<boolean> {
      if (!ready()) return false
      const peer = norm(identity)
      if (peer === localIdentity && (!device || device === localDevice)) return false
      if (openSession(peer, device || undefined)) return false
      const target = endpointKey(peer, device)
      if (dials.has(target) || (device && answering.has(target))) return false
      if (now - (dialedAt.get(target) ?? 0) < SESSION_DIAL_REPEAT_MS) return false
      dialedAt.set(target, now)
      const dial: Dial = {
        sid: newSid(),
        peer,
        device,
        phase: 'knocked',
        offer: PeerLink.createOffer(rtcOptions()).catch((err) => {
          log('local offer failed', err)
          return null
        }),
        done: false,
      }
      dials.set(target, dial)
      try {
        await post(peer, { kind: 'knock', sid: dial.sid, toDevice: device })
      } catch (err) {
        endDial(dial)
        log('knock not posted', err)
        return false
      }
      if (dial.done) return false
      dial.timer = setTimeout(() => endDial(dial, 'peer_unreachable'), SESSION_PRESENCE_MS)
      dial.total = setTimeout(() => endDial(dial, 'timeout'), CONNECT_MS)
      return true
    },

    /** One message from the signalling box, as `sender` (the carrier's sender) posted it. */
    async ingest(sender: string, body: string, now = Date.now()): Promise<SignalDisposition> {
      if (!wallet || !localIdentity || !localDevice) return 'invalid'
      let envelope: unknown
      try {
        envelope = JSON.parse(body)
      } catch {
        return 'invalid'
      }
      const opened = await openMessageSignal(wallet, norm(sender), envelope, {
        me: localIdentity,
        device: localDevice,
        replay,
        now,
        wanted,
      })
      if (opened.status !== 'signal') return opened.status === 'invalid' ? 'invalid' : 'not-mine'
      const s = opened.signal
      if (s.kind === 'knock') await onKnock(s)
      else if (s.kind === 'offer') await onOffer(s)
      else {
        const dial = dialFor(s)
        if (dial && !dial.done) {
          if (s.kind === 'ring') await onRing(dial, s)
          else if (s.kind === 'answer') await onAnswer(dial, s)
          else endDial(dial, `rejected: ${s.reason ?? 'no reason'}`)
        }
      }
      return 'handled'
    },

    /** Send on an open session, or report `box`. Never waits for a connection. */
    async deliver(args: { recipientIdentityKey: string; body: string; recipientDevice?: string }): Promise<'direct' | 'box'> {
      if (!args.body) return 'box'
      const found = openSession(args.recipientIdentityKey, args.recipientDevice)
      if (!found) return 'box'
      const session = found
      const key = endpointKey(session.peer, session.device)
      const frame = { t: 'msg' as const, id: messageId(), body: args.body }
      if (messageBytes(frame) > SESSION_MAX_MSG_BYTES) return 'box'
      const acked = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => settle(false), SESSION_ACK_MS)
        function settle(ok: boolean) {
          clearTimeout(timer)
          session.acks.delete(frame.id)
          resolve(ok)
        }
        session.acks.set(frame.id, settle)
        session.channel.send(frame).catch(() => settle(false))
      })
      if (acked) {
        touch(key, session)
        return 'direct'
      }
      drop(key, session)
      return 'box'
    },
  }
}

export type SessionTable = ReturnType<typeof createSessionTable>

const chat = createSessionTable()

export const installRtc = chat.installRtc
export const installSignalSender = chat.installSignalSender
export const installOfferPolicy = chat.installOfferPolicy
export const setDirectInboundHandler = chat.setInboundHandler
export const setDirectSessionIdentity = chat.setIdentity
export const resetDirectSessions = chat.reset
export const hasActiveSessionDials = chat.hasActiveDials
export const hasDirectSession = chat.hasSession
export const requestDirectSession = chat.request
export const ingestSessionSignal = chat.ingest
export const tryDirectDeliver = chat.deliver
