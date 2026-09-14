/**
 * Session upgrade (draft BRC-246).
 *
 * The identity key is the address. A signed IPv6 endpoint is a short-lived
 * hint carried in a BRC-33 message, never a handle record. The socket is an
 * optimization after both sides have authenticated. Custody stays on the chain.
 */

import { BigNumber, PrivateKey, PublicKey, Signature, Utils } from '@bsv/sdk'

export const SESSION_OFFER_PREFIX = 'handcash-session-offer:'
export const SESSION_OFFER_TTL_MS = 60_000
export const SESSION_RACE_MS = 300
export const SESSION_HELLO_SKEW_MS = 60_000
/** Bodies larger than this stay on the messagebox. */
export const SESSION_MAX_BODY = 256 * 1024

const OFFER_DOMAIN = 'session-upgrade\noffer'
const HELLO_DOMAIN = 'session-upgrade\nhello'
const WELCOME_DOMAIN = 'session-upgrade\nwelcome'

export type SessionOffer = {
  v: 1
  host: string
  port: number
  identityKey: string
  counterparty: string
  expiresAt: number
  nonce: string
  signature: string
}

export type SessionHello = {
  t: 'hello'
  offer: SessionOffer
  speaker: string
  timestamp: number
  nonce: string
  signature: string
}

export type SessionWelcome = {
  t: 'welcome'
  speaker: string
  timestamp: number
  nonce: string
  signature: string
  /** Hello nonce this welcome answers. */
  helloNonce: string
}

const NONCE_RE = /^[0-9a-f]{32}$/i

export function isGlobalUnicastIpv6(address: string): boolean {
  const bare = address.split('%')[0]?.trim().toLowerCase() ?? ''
  if (!bare.includes(':') || bare === '::' || bare === '::1') return false
  if (bare.startsWith('::ffff:')) return false
  const head = bare.split(':')[0] ?? ''
  if (!/^[0-9a-f]{1,4}$/.test(head)) return false
  const first = Number.parseInt(head, 16)
  if (first >= 0xfe80 && first <= 0xfebf) return false
  if (first >= 0xfc00 && first <= 0xfdff) return false
  if (first >= 0xff00) return false
  return first >= 0x2000 && first <= 0x3fff
}

/** Lower identity key dials. One socket, no simultaneous connect. */
export function sessionConnector(a: string, b: string): string {
  const left = a.trim().toLowerCase()
  const right = b.trim().toLowerCase()
  return left < right ? left : right
}

export function weDial(localIdentity: string, peerIdentity: string): boolean {
  return sessionConnector(localIdentity, peerIdentity) === localIdentity.trim().toLowerCase()
}

function compactHex(sig: Signature): string {
  const r = sig.r.toArray('be', 32)
  const s = sig.s.toArray('be', 32)
  return Utils.toHex([...r, ...s])
}

function verifyCompact(identityKey: string, preimage: string, signature: string): boolean {
  try {
    const compact = Utils.toArray(signature, 'hex')
    if (compact.length !== 64) return false
    const sig = new Signature(
      new BigNumber(Utils.toHex(compact.slice(0, 32)), 16),
      new BigNumber(Utils.toHex(compact.slice(32, 64)), 16),
    )
    return PublicKey.fromString(identityKey).verify(Utils.toArray(preimage, 'utf8'), sig)
  } catch {
    return false
  }
}

function identityKeyOf(rootKeyHex: string): string {
  return PrivateKey.fromHex(rootKeyHex.trim()).toPublicKey().toString().toLowerCase()
}

function signText(rootKeyHex: string, preimage: string): string {
  return compactHex(PrivateKey.fromHex(rootKeyHex.trim()).sign(Utils.toArray(preimage, 'utf8')))
}

function nonce(): string {
  return Utils.toHex(Array.from({ length: 16 }, () => Math.floor(Math.random() * 256)))
}

export function offerPreimage(offer: Omit<SessionOffer, 'signature'>): string {
  return [
    OFFER_DOMAIN,
    offer.identityKey,
    offer.counterparty,
    offer.host,
    String(offer.port),
    String(offer.expiresAt),
    offer.nonce,
  ].join('\n')
}

export function signSessionOffer(args: {
  rootKeyHex: string
  counterparty: string
  host: string
  port: number
  now?: number
}): SessionOffer {
  const host = args.host.split('%')[0]?.trim().toLowerCase() ?? ''
  if (!isGlobalUnicastIpv6(host)) {
    throw new Error('Session offer host must be a global IPv6 address.')
  }
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) {
    throw new Error('Session offer port is out of range.')
  }
  const identityKey = identityKeyOf(args.rootKeyHex)
  const counterparty = args.counterparty.trim().toLowerCase()
  if (counterparty === identityKey) throw new Error('Session offer cannot name this wallet as its peer.')
  const expiresAt = (args.now ?? Date.now()) + SESSION_OFFER_TTL_MS
  const draft = {
    v: 1 as const,
    host,
    port: args.port,
    identityKey,
    counterparty,
    expiresAt,
    nonce: nonce(),
  }
  return { ...draft, signature: signText(args.rootKeyHex, offerPreimage(draft)) }
}

export function verifySessionOffer(
  offer: SessionOffer,
  args: { localIdentity: string; now?: number },
): boolean {
  const now = args.now ?? Date.now()
  if (offer.v !== 1) return false
  if (!isGlobalUnicastIpv6(offer.host)) return false
  if (!Number.isInteger(offer.port) || offer.port < 1 || offer.port > 65535) return false
  if (!NONCE_RE.test(offer.nonce)) return false
  if (!Number.isFinite(offer.expiresAt) || offer.expiresAt < now - 5_000) return false
  if (offer.expiresAt > now + SESSION_OFFER_TTL_MS + 5_000) return false
  const local = args.localIdentity.trim().toLowerCase()
  if (offer.counterparty.trim().toLowerCase() !== local) return false
  if (offer.identityKey.trim().toLowerCase() === local) return false
  const { signature, ...draft } = offer
  return verifyCompact(offer.identityKey, offerPreimage(draft), signature)
}

export function encodeSessionOffer(offer: SessionOffer): string {
  return `${SESSION_OFFER_PREFIX}${JSON.stringify(offer)}`
}

export function decodeSessionOffer(body: string): SessionOffer | null {
  if (!body.startsWith(SESSION_OFFER_PREFIX)) return null
  try {
    const parsed = JSON.parse(body.slice(SESSION_OFFER_PREFIX.length)) as SessionOffer
    if (!parsed || parsed.v !== 1 || typeof parsed.signature !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

export function helloPreimage(hello: Omit<SessionHello, 'signature' | 't'>): string {
  return [
    HELLO_DOMAIN,
    hello.speaker,
    hello.offer.identityKey,
    hello.offer.host,
    String(hello.offer.port),
    hello.offer.nonce,
    hello.nonce,
    String(hello.timestamp),
  ].join('\n')
}

export function signSessionHello(args: {
  rootKeyHex: string
  offer: SessionOffer
  now?: number
}): SessionHello {
  const speaker = identityKeyOf(args.rootKeyHex)
  if (speaker !== args.offer.counterparty.trim().toLowerCase()) {
    throw new Error('Only the named counterparty can open this session.')
  }
  const draft = {
    offer: args.offer,
    speaker,
    timestamp: args.now ?? Date.now(),
    nonce: nonce(),
  }
  return { t: 'hello', ...draft, signature: signText(args.rootKeyHex, helloPreimage(draft)) }
}

function offerSignatureOk(offer: SessionOffer, now: number): boolean {
  if (offer.v !== 1) return false
  if (!isGlobalUnicastIpv6(offer.host)) return false
  if (!Number.isInteger(offer.port) || offer.port < 1 || offer.port > 65535) return false
  if (!NONCE_RE.test(offer.nonce)) return false
  if (!Number.isFinite(offer.expiresAt) || offer.expiresAt < now - 5_000) return false
  if (offer.expiresAt > now + SESSION_OFFER_TTL_MS + 5_000) return false
  const { signature, ...draft } = offer
  return verifyCompact(offer.identityKey, offerPreimage(draft), signature)
}

export function verifySessionHello(
  hello: SessionHello,
  args: { localIdentity: string; now?: number },
): boolean {
  const now = args.now ?? Date.now()
  if (hello.t !== 'hello') return false
  if (!offerSignatureOk(hello.offer, now)) return false
  const local = args.localIdentity.trim().toLowerCase()
  if (hello.offer.identityKey.trim().toLowerCase() !== local) return false
  if (Math.abs(now - hello.timestamp) > SESSION_HELLO_SKEW_MS) return false
  if (!NONCE_RE.test(hello.nonce)) return false
  const speaker = hello.speaker.trim().toLowerCase()
  if (speaker !== hello.offer.counterparty.trim().toLowerCase()) return false
  const { signature, t: _t, ...draft } = hello
  return verifyCompact(speaker, helloPreimage(draft), signature)
}

export function welcomePreimage(welcome: Omit<SessionWelcome, 'signature' | 't'> & { peer: string; host: string; port: number }): string {
  return [
    WELCOME_DOMAIN,
    welcome.speaker,
    welcome.peer,
    welcome.host,
    String(welcome.port),
    welcome.helloNonce,
    welcome.nonce,
    String(welcome.timestamp),
  ].join('\n')
}

export function signSessionWelcome(args: {
  rootKeyHex: string
  hello: SessionHello
  now?: number
}): SessionWelcome {
  const speaker = identityKeyOf(args.rootKeyHex)
  if (speaker !== args.hello.offer.identityKey.trim().toLowerCase()) {
    throw new Error('Only the offer signer can welcome this session.')
  }
  const draft = {
    speaker,
    peer: args.hello.speaker.trim().toLowerCase(),
    host: args.hello.offer.host,
    port: args.hello.offer.port,
    helloNonce: args.hello.nonce,
    timestamp: args.now ?? Date.now(),
    nonce: nonce(),
  }
  return {
    t: 'welcome',
    speaker: draft.speaker,
    timestamp: draft.timestamp,
    nonce: draft.nonce,
    helloNonce: draft.helloNonce,
    signature: signText(args.rootKeyHex, welcomePreimage(draft)),
  }
}

export function verifySessionWelcome(
  welcome: SessionWelcome,
  args: { hello: SessionHello; now?: number },
): boolean {
  const now = args.now ?? Date.now()
  if (welcome.t !== 'welcome') return false
  if (Math.abs(now - welcome.timestamp) > SESSION_HELLO_SKEW_MS) return false
  if (!NONCE_RE.test(welcome.nonce)) return false
  if (welcome.helloNonce !== args.hello.nonce) return false
  const speaker = welcome.speaker.trim().toLowerCase()
  if (speaker !== args.hello.offer.identityKey.trim().toLowerCase()) return false
  return verifyCompact(
    speaker,
    welcomePreimage({
      speaker,
      peer: args.hello.speaker.trim().toLowerCase(),
      host: args.hello.offer.host,
      port: args.hello.offer.port,
      helloNonce: welcome.helloNonce,
      nonce: welcome.nonce,
      timestamp: welcome.timestamp,
    }),
    welcome.signature,
  )
}

/** Node connect errors that fail immediately. A timeout is not one of these. */
export function isImmediateConnectFailure(code: string | undefined): boolean {
  return (
    code === 'ECONNREFUSED' ||
    code === 'ENETUNREACH' ||
    code === 'EHOSTUNREACH' ||
    code === 'EADDRNOTAVAIL' ||
    code === 'ENOTFOUND' ||
    code === 'ECONNRESET'
  )
}
