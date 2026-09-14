/**
 * Hot-path session table. The messagebox remains the rendezvous and the
 * offline inbox. A direct send happens only after a mutual handshake, and a
 * failed socket falls back to the box for that message.
 */

import {
  SESSION_MAX_BODY,
  SESSION_RACE_MS,
  decodeSessionOffer,
  encodeSessionOffer,
  signSessionHello,
  signSessionOffer,
  signSessionWelcome,
  verifySessionHello,
  verifySessionOffer,
  verifySessionWelcome,
  weDial,
  type SessionHello,
  type SessionOffer,
  type SessionWelcome,
} from './protocol'

export type DirectConnectResult =
  | { ok: true; remoteHello: string; socketId: string }
  | { ok: false; immediate: boolean }

export type DirectSessionPort = {
  listen(): Promise<{ host: string; port: number } | null>
  connect(args: {
    host: string
    port: number
    timeoutMs: number
    hello: string
  }): Promise<DirectConnectResult>
  send(socketId: string, body: string, timeoutMs: number): Promise<boolean>
  close(socketId: string): Promise<void>
  accept(socketId: string, welcome: string): Promise<void>
  reject(socketId: string): Promise<void>
}

type Hot = { socketId: string; peer: string }

let port: DirectSessionPort | null = null
let localEndpoint: { host: string; port: number } | null = null
let listenAttemptAt = 0
let rootKeyHex = ''
let localIdentity = ''
const candidates = new Map<string, SessionOffer>()
const hot = new Map<string, Hot>()
const offerSentAt = new Map<string, number>()
let onInboundBody: ((sender: string, body: string) => void) | null = null

const LISTEN_RETRY_MS = 60_000
const OFFER_REPEAT_MS = 20_000

export function installDirectSessionPort(next: DirectSessionPort | null): void {
  port = next
  if (!next) {
    localEndpoint = null
    hot.clear()
  }
}

export function setDirectSessionIdentity(args: { rootKeyHex: string; identityKey: string }): void {
  rootKeyHex = args.rootKeyHex
  localIdentity = args.identityKey.trim().toLowerCase()
}

export function setDirectInboundHandler(handler: ((sender: string, body: string) => void) | null): void {
  onInboundBody = handler
}

export function resetDirectSessions(): void {
  candidates.clear()
  hot.clear()
  offerSentAt.clear()
  localEndpoint = null
  listenAttemptAt = 0
}

function peerKey(identity: string): string {
  return identity.trim().toLowerCase()
}

export function rememberSessionOffer(offer: SessionOffer, now = Date.now()): boolean {
  if (!localIdentity) return false
  if (!verifySessionOffer(offer, { localIdentity, now })) return false
  candidates.set(peerKey(offer.identityKey), offer)
  return true
}

export function dropSessionPeer(identity: string): void {
  const peer = peerKey(identity)
  candidates.delete(peer)
  const live = hot.get(peer)
  hot.delete(peer)
  if (live && port) void port.close(live.socketId)
}

function liveOffer(peer: string, now: number): SessionOffer | null {
  const offer = candidates.get(peer)
  if (!offer) return null
  if (!verifySessionOffer(offer, { localIdentity, now })) {
    candidates.delete(peer)
    return null
  }
  return offer
}

export async function ensureDirectListener(): Promise<{ host: string; port: number } | null> {
  if (!port || !rootKeyHex) return null
  if (localEndpoint) return localEndpoint
  if (Date.now() - listenAttemptAt < LISTEN_RETRY_MS) return null
  listenAttemptAt = Date.now()
  try {
    localEndpoint = await port.listen()
  } catch {
    localEndpoint = null
  }
  return localEndpoint
}

export function localSessionEndpoint(): { host: string; port: number } | null {
  return localEndpoint
}

/** Signed offer for the box, only while this device is listening. Rate-limited per peer. */
export function sessionOfferMessage(counterparty: string, now = Date.now()): string | null {
  if (!localEndpoint || !rootKeyHex) return null
  const peer = peerKey(counterparty)
  const last = offerSentAt.get(peer) ?? 0
  if (now - last < OFFER_REPEAT_MS) return null
  try {
    const offer = signSessionOffer({
      rootKeyHex,
      counterparty: peer,
      host: localEndpoint.host,
      port: localEndpoint.port,
      now,
    })
    offerSentAt.set(peer, now)
    return encodeSessionOffer(offer)
  } catch {
    return null
  }
}

export function noteSessionOfferSent(counterparty: string, now = Date.now()): void {
  offerSentAt.set(peerKey(counterparty), now)
}

async function markHot(peer: string, socketId: string): Promise<void> {
  const prev = hot.get(peer)
  if (prev && prev.socketId !== socketId && port) void port.close(prev.socketId)
  hot.set(peer, { socketId, peer })
}

export async function handleDirectHello(socketId: string, hello: SessionHello): Promise<boolean> {
  if (!port || !rootKeyHex || !localIdentity) {
    await port?.reject(socketId)
    return false
  }
  if (hot.has(peerKey(hello.speaker))) {
    await port.reject(socketId)
    return false
  }
  if (!verifySessionHello(hello, { localIdentity })) {
    await port.reject(socketId)
    return false
  }
  try {
    const welcome = signSessionWelcome({ rootKeyHex, hello })
    await port.accept(socketId, JSON.stringify(welcome))
    await markHot(peerKey(hello.speaker), socketId)
    return true
  } catch {
    await port.reject(socketId)
    return false
  }
}

export function handleDirectClosed(socketId: string): void {
  for (const [peer, live] of hot) {
    if (live.socketId === socketId) hot.delete(peer)
  }
}

export function handleDirectInbound(sender: string, body: string): void {
  onInboundBody?.(sender, body)
}

async function finishConnect(
  hello: SessionHello,
  result: DirectConnectResult,
): Promise<boolean> {
  if (!result.ok || !port) return false
  let welcome: SessionWelcome
  try {
    welcome = JSON.parse(result.remoteHello) as SessionWelcome
  } catch {
    await port.close(result.socketId)
    return false
  }
  if (!verifySessionWelcome(welcome, { hello })) {
    await port.close(result.socketId)
    return false
  }
  await markHot(peerKey(hello.offer.identityKey), result.socketId)
  return true
}

/**
 * Send on a live socket, or race a short dial against the box budget.
 * `timeout` means this message goes to the box; a late handshake may still
 * become hot for the next one, and must not also carry this body.
 */
export async function tryDirectDeliver(args: {
  recipientIdentityKey: string
  body: string
  now?: number
}): Promise<'direct' | 'box'> {
  if (!port || !rootKeyHex || !localIdentity) return 'box'
  if (args.body.length > SESSION_MAX_BODY) return 'box'
  const peer = peerKey(args.recipientIdentityKey)
  const live = hot.get(peer)
  if (live) {
    if (!args.body) return 'direct'
    const ok = await port.send(live.socketId, args.body, SESSION_RACE_MS)
    if (ok) return 'direct'
    hot.delete(peer)
    void port.close(live.socketId)
  }
  const offer = liveOffer(peer, args.now ?? Date.now())
  if (!offer || !weDial(localIdentity, peer)) return 'box'

  let hello: SessionHello
  try {
    hello = signSessionHello({ rootKeyHex, offer, now: args.now })
  } catch {
    return 'box'
  }

  const pending = port.connect({
    host: offer.host,
    port: offer.port,
    timeoutMs: SESSION_RACE_MS,
    hello: JSON.stringify(hello),
  })
  let committed = false
  const outcome = await Promise.race([
    pending.then((result) => ({ kind: 'connect' as const, result })),
    new Promise<{ kind: 'timeout' }>((resolve) => {
      setTimeout(() => resolve({ kind: 'timeout' }), SESSION_RACE_MS)
    }),
  ])

  if (outcome.kind === 'timeout') {
    void pending.then(async (result) => {
      if (committed) return
      if (!result.ok) {
        if (result.immediate) candidates.delete(peer)
        return
      }
      await finishConnect(hello, result)
    })
    return 'box'
  }

  committed = true
  if (!outcome.result.ok) {
    if (outcome.result.immediate) candidates.delete(peer)
    return 'box'
  }
  const ready = await finishConnect(hello, outcome.result)
  if (!ready) return 'box'
  if (!args.body) return 'direct'
  const socketId = outcome.result.socketId
  const sent = await port.send(socketId, args.body, SESSION_RACE_MS)
  if (sent) return 'direct'
  hot.delete(peer)
  void port.close(socketId)
  return 'box'
}

export function ingestSessionOfferBody(body: string, now = Date.now()): boolean {
  const offer = decodeSessionOffer(body)
  if (!offer) return false
  return rememberSessionOffer(offer, now)
}

/** Open the socket after a peer offer arrives. Does not send a payload. */
export function warmDirectSession(peerIdentity: string): void {
  if (!port || !localIdentity || !weDial(localIdentity, peerIdentity)) return
  if (hot.has(peerKey(peerIdentity))) return
  void tryDirectDeliver({ recipientIdentityKey: peerIdentity, body: '' })
}
