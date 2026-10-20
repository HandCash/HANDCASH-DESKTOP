/**
 * Signals for draft BRC-246 sessions: `webrtpay/1` signalling envelopes
 * (§7.1 to §7.3), sealed with BRC-2 under `[2, 'webrtpay signaling']`, whose
 * plaintext has purpose `messages` and names the sending and receiving
 * installs. They ride box `webrtpay_messages`, never `webrtpay_signals`.
 */

import {
  DEFAULTS,
  MAX_SIGNAL_SDP_CHARS,
  SIGNALING_PROTOCOL_ID,
  isIdentityKey,
  isSignalChain,
  isSignalEnvelope,
  randomBytes,
  toBase64,
  fromBase64,
  toBase64Url,
  utf8Decode,
  utf8Encode,
  type ReplayCache,
  type SignalEnvelope,
  type WalletLike,
} from '@bsv/webrtpay'

export const MESSAGES_BOX = 'webrtpay_messages'
export const MESSAGES_PURPOSE = 'messages'

export type MessageSignalKind = 'knock' | 'ring' | 'offer' | 'answer' | 'reject'

export type MessageSignal = {
  v: 1
  kind: MessageSignalKind
  sid: string
  from: string
  to: string
  ts: number
  purpose: typeof MESSAGES_PURPOSE
  fromDevice: string
  /** Empty only in a knock or offer to another identity: whichever install answers. */
  toDevice: string
  sdp?: string
  reason?: string
  chain?: string
}

/** `own`: this install sent it. `not-mine`: it names another install; leave it in the box. */
export type OpenedSignal =
  | { status: 'signal'; signal: MessageSignal }
  | { status: 'own' | 'not-mine' | 'invalid' }

const KINDS: ReadonlySet<string> = new Set<MessageSignalKind>(['knock', 'ring', 'offer', 'answer', 'reject'])
const BARE_KINDS: ReadonlySet<string> = new Set<MessageSignalKind>(['knock', 'ring'])
/** Kinds that answer a dial, so they always name the dialling install. */
const REPLY_KINDS: ReadonlySet<string> = new Set<MessageSignalKind>(['ring', 'answer', 'reject'])
const DEVICE_RE = /^[A-Za-z0-9._-]{1,128}$/
const MAX_REASON_CHARS = 200

export function isSessionDevice(device: string): boolean {
  return DEVICE_RE.test(device)
}

/** 16 random bytes, base64url: the id every signal of one dial shares. */
export function newSid(): string {
  return toBase64Url(randomBytes(16))
}

/** Glare: the endpoint whose `identityKey\ndevice` sorts lower keeps its own dial. */
export function keepsOwnDialOnGlare(
  local: { identityKey: string; device: string },
  remote: { identityKey: string; device: string },
): boolean {
  return `${local.identityKey}\n${local.device}` < `${remote.identityKey}\n${remote.device}`
}

function devicesOk(s: Pick<MessageSignal, 'kind' | 'from' | 'to' | 'fromDevice' | 'toDevice'>): boolean {
  if (!isSessionDevice(s.fromDevice)) return false
  if (s.toDevice !== '' && !isSessionDevice(s.toDevice)) return false
  if (s.toDevice === '' && (s.to === s.from || REPLY_KINDS.has(s.kind))) return false
  return !(s.to === s.from && s.toDevice === s.fromDevice)
}

/** Encrypt `p` for `p.to`; only the fields of {@link MessageSignal} are carried. */
export async function sealMessageSignal(
  wallet: Pick<WalletLike, 'encrypt'>,
  p: Omit<MessageSignal, 'v' | 'purpose'>,
): Promise<SignalEnvelope> {
  if (!devicesOk(p)) throw new TypeError('Signal devices are invalid')
  if (p.chain !== undefined && !isSignalChain(p.chain)) throw new TypeError('Signal chain is invalid')
  const plaintext: MessageSignal = {
    v: 1,
    kind: p.kind,
    sid: p.sid,
    from: p.from,
    to: p.to,
    ts: p.ts,
    purpose: MESSAGES_PURPOSE,
    fromDevice: p.fromDevice,
    toDevice: p.toDevice,
    ...(p.sdp === undefined ? {} : { sdp: p.sdp }),
    ...(p.reason === undefined ? {} : { reason: p.reason }),
    ...(p.chain === undefined ? {} : { chain: p.chain }),
  }
  const { ciphertext } = await wallet.encrypt({
    plaintext: Array.from(utf8Encode(JSON.stringify(plaintext))),
    protocolID: SIGNALING_PROTOCOL_ID,
    keyID: p.sid,
    counterparty: p.to,
  })
  return { v: 1, sid: p.sid, ciphertext: toBase64(Uint8Array.from(ciphertext)) }
}

function toSignal(x: unknown): MessageSignal | null {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return null
  const r = x as Record<string, unknown>
  if (
    r.v !== 1 ||
    typeof r.kind !== 'string' ||
    !KINDS.has(r.kind) ||
    typeof r.sid !== 'string' ||
    typeof r.from !== 'string' ||
    typeof r.to !== 'string' ||
    typeof r.ts !== 'number' ||
    !Number.isFinite(r.ts) ||
    r.purpose !== MESSAGES_PURPOSE ||
    typeof r.fromDevice !== 'string' ||
    typeof r.toDevice !== 'string' ||
    (r.sdp != null && typeof r.sdp !== 'string') ||
    (r.reason != null && typeof r.reason !== 'string') ||
    (r.chain != null && !isSignalChain(r.chain))
  ) {
    return null
  }
  if (BARE_KINDS.has(r.kind) && (r.sdp != null || r.reason != null)) return null
  const signal: MessageSignal = {
    v: 1,
    kind: r.kind as MessageSignalKind,
    sid: r.sid,
    from: r.from,
    to: r.to,
    ts: r.ts,
    purpose: MESSAGES_PURPOSE,
    fromDevice: r.fromDevice,
    toDevice: r.toDevice,
  }
  if (r.sdp != null) signal.sdp = r.sdp as string
  if (r.reason != null) signal.reason = (r.reason as string).slice(0, MAX_REASON_CHARS)
  if (r.chain != null) signal.chain = r.chain as string
  return signal
}

function replayKey(s: MessageSignal): string {
  return BARE_KINDS.has(s.kind) ? `${s.kind} ${s.sid}` : s.sid
}

/**
 * Open a signal the carrier says came from `from`, as `webrtpay/1` §7.4 does
 * with purpose `messages`. The device rules of draft BRC-246 §3 run first,
 * after decryption, so a sibling's signal is left for it and never burns a
 * sid here. `wanted` runs last, before the sid is recorded.
 */
export async function openMessageSignal(
  wallet: Pick<WalletLike, 'decrypt'>,
  from: string,
  envelope: unknown,
  o: {
    me: string
    device: string
    replay: ReplayCache
    now?: number
    wanted?: (signal: MessageSignal) => boolean
  },
): Promise<OpenedSignal> {
  if (!isSignalEnvelope(envelope) || !isIdentityKey(from)) return { status: 'invalid' }
  let decoded: unknown
  try {
    const { plaintext } = await wallet.decrypt({
      ciphertext: Array.from(fromBase64(envelope.ciphertext)),
      protocolID: SIGNALING_PROTOCOL_ID,
      keyID: envelope.sid,
      counterparty: from,
    })
    decoded = JSON.parse(utf8Decode(Uint8Array.from(plaintext)))
  } catch {
    return { status: 'invalid' }
  }
  const signal = toSignal(decoded)
  if (!signal || signal.from !== from || signal.to !== o.me || signal.sid !== envelope.sid) return { status: 'invalid' }
  if (signal.from === o.me && signal.fromDevice === o.device) return { status: 'own' }
  if (signal.toDevice !== '' && signal.toDevice !== o.device) return { status: 'not-mine' }
  if (!devicesOk(signal)) return { status: 'invalid' }
  const now = o.now ?? Date.now()
  if (Math.abs(now - signal.ts) > DEFAULTS.signalMaxSkewMs) return { status: 'invalid' }
  if (signal.sdp !== undefined && signal.sdp.length > MAX_SIGNAL_SDP_CHARS) return { status: 'invalid' }
  if (o.wanted && !o.wanted(signal)) return { status: 'invalid' }
  if (!o.replay.check(replayKey(signal), now, signal.ts)) return { status: 'invalid' }
  return { status: 'signal', signal }
}
