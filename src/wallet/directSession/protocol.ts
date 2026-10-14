/**
 * Session upgrade (draft BRC-246 v2).
 *
 * The identity key is the address. A signed WebRTC offer or answer rides the
 * messagebox, sealed to its recipient, in box `session-upgrade`. Each
 * signature covers the whole session description, so the DTLS fingerprint in
 * it is bound to the identity key. Custody stays on the chain.
 */

import { BigNumber, Hash, PrivateKey, PublicKey, Signature, Utils } from '@bsv/sdk'

export const SESSION_BOX = 'session-upgrade'
export const SESSION_OFFER_TTL_MS = 120_000
export const SESSION_SKEW_MS = 5_000
/** Non-trickle: sign the description once gathering completes or this passes. */
export const SESSION_GATHER_MS = 3_000
export const SESSION_ACK_MS = 1_000
export const SESSION_OFFER_REPEAT_MS = 20_000
export const SESSION_IDLE_MS = 10 * 60_000
/** Bodies larger than this stay on the messagebox. */
export const SESSION_MAX_BODY = 256 * 1024
export const SESSION_CHANNEL_LABEL = 'brc246'

/** v1 offers from older installs land in `inbox`; never show them as chat. */
const LEGACY_OFFER_PREFIX = 'handcash-session-offer:'
const DOMAIN = 'session-upgrade\nv2'

export type SignalKind = 'offer' | 'answer'

export type SessionSignal = {
  v: 2
  t: SignalKind
  from: string
  fromDevice: string
  to: string
  toDevice: string
  offerNonce: string
  sdp: string
  expiresAt: number
  nonce: string
  signature: string
}

const NONCE_RE = /^[0-9a-f]{32}$/
const DEVICE_RE = /^[A-Za-z0-9._-]{1,128}$/
const KEY_RE = /^0[23][0-9a-f]{64}$/

export function isSessionDevice(device: string): boolean {
  return DEVICE_RE.test(device)
}

function normKey(key: string): string {
  return key.trim().toLowerCase()
}

/** Glare: the endpoint whose `identityKey\ndevice` sorts lower keeps its own offer. */
export function keepsOwnOfferOnGlare(
  local: { identityKey: string; device: string },
  remote: { identityKey: string; device: string },
): boolean {
  return `${normKey(local.identityKey)}\n${local.device}` < `${normKey(remote.identityKey)}\n${remote.device}`
}

export function isLegacySessionOffer(body: string): boolean {
  return body.startsWith(LEGACY_OFFER_PREFIX)
}

function compactHex(sig: Signature): string {
  return Utils.toHex([...sig.r.toArray('be', 32), ...sig.s.toArray('be', 32)])
}

function verifyCompact(identityKey: string, preimage: string, signature: string): boolean {
  try {
    if (!/^[0-9a-f]{128}$/.test(signature)) return false
    const compact = Utils.toArray(signature, 'hex')
    const sig = new Signature(
      new BigNumber(Utils.toHex(compact.slice(0, 32)), 16),
      new BigNumber(Utils.toHex(compact.slice(32, 64)), 16),
    )
    return PublicKey.fromString(identityKey).verify(Utils.toArray(preimage, 'utf8'), sig)
  } catch {
    return false
  }
}

function nonce(): string {
  return Utils.toHex(Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16))))
}

export function sdpHash(sdp: string): string {
  return Utils.toHex(Hash.sha256(Utils.toArray(sdp, 'utf8')))
}

export function signalPreimage(signal: Omit<SessionSignal, 'signature'>): string {
  return [
    DOMAIN,
    signal.t,
    signal.from,
    signal.fromDevice,
    signal.to,
    signal.toDevice,
    signal.offerNonce,
    sdpHash(signal.sdp),
    String(signal.expiresAt),
    signal.nonce,
  ].join('\n')
}

/**
 * One data-channel section, no audio or video, exactly one sha-256 DTLS
 * fingerprint. Candidates ride inside the description (no trickle).
 */
export function acceptableSessionSdp(sdp: string): boolean {
  if (typeof sdp !== 'string' || !sdp || sdp.length > 64 * 1024) return false
  const lines = sdp.split(/\r?\n/)
  const media = lines.filter(line => line.startsWith('m='))
  if (media.length !== 1 || !/^m=application \d+ UDP\/DTLS\/SCTP webrtc-datachannel$/.test(media[0]!.trim())) return false
  const fingerprints = new Set(
    lines
      .filter(line => line.startsWith('a=fingerprint:'))
      .map(line => line.slice('a=fingerprint:'.length).trim().toLowerCase()),
  )
  if (fingerprints.size !== 1) return false
  return [...fingerprints][0]!.startsWith('sha-256 ')
}

export function signSessionSignal(args: {
  rootKeyHex: string
  t: SignalKind
  fromDevice: string
  to: string
  toDevice: string
  offerNonce?: string
  sdp: string
  expiresAt?: number
  now?: number
}): SessionSignal {
  const root = PrivateKey.fromHex(args.rootKeyHex.trim())
  const from = normKey(root.toPublicKey().toString())
  const to = normKey(args.to)
  if (!isSessionDevice(args.fromDevice)) throw new Error('Session device is invalid.')
  if (args.toDevice && !isSessionDevice(args.toDevice)) throw new Error('Session peer device is invalid.')
  if (to === from && (!args.toDevice || args.toDevice === args.fromDevice)) {
    throw new Error('A session with this identity must name another install.')
  }
  if (args.t === 'answer' && (!args.offerNonce || !args.toDevice)) {
    throw new Error('An answer must name its offer and the offering install.')
  }
  const draft: Omit<SessionSignal, 'signature'> = {
    v: 2,
    t: args.t,
    from,
    fromDevice: args.fromDevice,
    to,
    toDevice: args.toDevice,
    offerNonce: args.t === 'answer' ? args.offerNonce! : '',
    sdp: args.sdp,
    expiresAt: args.expiresAt ?? (args.now ?? Date.now()) + SESSION_OFFER_TTL_MS,
    nonce: nonce(),
  }
  return { ...draft, signature: compactHex(root.sign(Utils.toArray(signalPreimage(draft), 'utf8'))) }
}

function signatureOk(signal: SessionSignal): boolean {
  const { signature, ...draft } = signal
  return verifyCompact(signal.from, signalPreimage(draft), signature)
}

function timely(signal: SessionSignal, now: number): boolean {
  return (
    Number.isSafeInteger(signal.expiresAt) &&
    signal.expiresAt >= now - SESSION_SKEW_MS &&
    signal.expiresAt <= now + SESSION_OFFER_TTL_MS + SESSION_SKEW_MS
  )
}

export function verifySessionOffer(
  offer: SessionSignal,
  local: { identityKey: string; device: string; now?: number },
): boolean {
  const now = local.now ?? Date.now()
  const me = normKey(local.identityKey)
  if (offer.t !== 'offer' || offer.offerNonce !== '') return false
  if (offer.to !== me) return false
  if (offer.toDevice && offer.toDevice !== local.device) return false
  if (offer.from === me && (offer.toDevice !== local.device || offer.fromDevice === local.device)) return false
  if (!timely(offer, now)) return false
  if (!acceptableSessionSdp(offer.sdp)) return false
  return signatureOk(offer)
}

export function verifySessionAnswer(
  answer: SessionSignal,
  args: { offer: SessionSignal; now?: number },
): boolean {
  const now = args.now ?? Date.now()
  const { offer } = args
  if (answer.t !== 'answer') return false
  if (answer.offerNonce !== offer.nonce) return false
  if (answer.from !== offer.to) return false
  if (offer.toDevice && answer.fromDevice !== offer.toDevice) return false
  if (answer.from === offer.from && answer.fromDevice === offer.fromDevice) return false
  if (answer.to !== offer.from || answer.toDevice !== offer.fromDevice) return false
  if (answer.expiresAt !== offer.expiresAt || answer.expiresAt < now - SESSION_SKEW_MS) return false
  if (!acceptableSessionSdp(answer.sdp)) return false
  return signatureOk(answer)
}

export function encodeSessionSignal(signal: SessionSignal): string {
  return JSON.stringify(signal)
}

/** Shape check only; verification is `verifySessionOffer` / `verifySessionAnswer`. */
export function decodeSessionSignal(body: string): SessionSignal | null {
  try {
    const s = JSON.parse(body) as Partial<SessionSignal>
    if (!s || s.v !== 2 || (s.t !== 'offer' && s.t !== 'answer')) return null
    if (typeof s.from !== 'string' || !KEY_RE.test(s.from)) return null
    if (typeof s.to !== 'string' || !KEY_RE.test(s.to)) return null
    if (typeof s.fromDevice !== 'string' || !isSessionDevice(s.fromDevice)) return null
    if (typeof s.toDevice !== 'string' || (s.toDevice !== '' && !isSessionDevice(s.toDevice))) return null
    if (typeof s.offerNonce !== 'string' || (s.offerNonce !== '' && !NONCE_RE.test(s.offerNonce))) return null
    if (typeof s.sdp !== 'string' || typeof s.expiresAt !== 'number') return null
    if (typeof s.nonce !== 'string' || !NONCE_RE.test(s.nonce)) return null
    if (typeof s.signature !== 'string') return null
    return s as SessionSignal
  } catch {
    return null
  }
}
