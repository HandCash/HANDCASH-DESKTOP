/**
 * Interim messagebox identity proof (pre–BRC-103/104).
 *
 * BRC-33 requires authenticated PeerServ sessions. Until BRC-103/104 is wired,
 * clients prove possession of an identity key by ECDSA-signing a canonical
 * UTF-8 preimage (Bitcoin-style: SHA-256 then secp256k1). The messagebox binds
 * list/ack to that key (recipient) and send/files to that key (sender).
 *
 * Preimage (UTF-8):
 *   BRC-33-lite\n{method}\n{messageBox}\n{timestampMs}
 *
 * Wire headers (fetch):
 *   X-BRC33-Identity / Timestamp / Signature  — interim ECDSA (always)
 *
 * BRC-103 identity proof is still signed locally but **not** attached to fetch
 * by default. Extra `X-BRC103-*` headers trip CORS preflight on Android WebView
 * when the box Allow-Headers list only has X-BRC33-* (and browsers cache that
 * miss for Access-Control-Max-Age). BRC-CLOUD accepts either; full Authrite
 * Peer sessions + certificates still deferred.
 */
import { BigNumber, PrivateKey, PublicKey, Signature, Utils } from '@bsv/sdk'

export type MessageboxMethod =
  | 'sendMessage'
  | 'listMessages'
  | 'acknowledgeMessage'
  | 'files'

export const MESSAGEBOX_AUTH_MAX_SKEW_MS = 5 * 60 * 1000

export function messageboxAuthPreimage(args: {
  method: MessageboxMethod
  messageBox: string
  timestamp: number
}): string {
  return `BRC-33-lite\n${args.method}\n${args.messageBox}\n${args.timestamp}`
}

export function messageboxAuthritePreimage(args: {
  method: MessageboxMethod
  messageBox: string
  timestamp: number
  nonce: string
}): string {
  return `BRC-103-identity\n${args.method}\n${args.messageBox}\n${args.timestamp}\n${args.nonce}`
}

function compactHexFromSig(sig: Signature): string {
  const r = sig.r.toArray('be', 32)
  const s = sig.s.toArray('be', 32)
  return Utils.toHex([...r, ...s])
}

export function signMessageboxAuth(args: {
  rootKeyHex: string
  method: MessageboxMethod
  messageBox?: string
  timestamp?: number
  nonce?: string
}): {
  identityKey: string
  timestamp: number
  signature: string
  messageBox: string
  nonce: string
  authriteSignature: string
} {
  const messageBox = (args.messageBox || 'inbox').trim() || 'inbox'
  const timestamp = args.timestamp ?? Date.now()
  const nonce =
    args.nonce?.trim() ||
    Utils.toHex(Array.from({ length: 16 }, () => Math.floor(Math.random() * 256)))
  const root = PrivateKey.fromHex(args.rootKeyHex.trim())
  const identityKey = root.toPublicKey().toString().toLowerCase()
  const preimage = messageboxAuthPreimage({
    method: args.method,
    messageBox,
    timestamp,
  })
  const authritePreimage = messageboxAuthritePreimage({
    method: args.method,
    messageBox,
    timestamp,
    nonce,
  })
  // PrivateKey.sign SHA-256-hashes the message (same as noble verify default).
  const signature = compactHexFromSig(
    root.sign(Utils.toArray(preimage, 'utf8')),
  )
  const authriteSignature = compactHexFromSig(
    root.sign(Utils.toArray(authritePreimage, 'utf8')),
  )
  return { identityKey, timestamp, signature, messageBox, nonce, authriteSignature }
}

export function messageboxAuthHeaders(
  auth: {
    identityKey: string
    timestamp: number
    signature: string
    nonce?: string
    authriteSignature?: string
  },
  opts?: { includeAuthrite?: boolean },
): Record<string, string> {
  const headers: Record<string, string> = {
    'X-BRC33-Identity': auth.identityKey,
    'X-BRC33-Timestamp': String(auth.timestamp),
    'X-BRC33-Signature': auth.signature,
  }
  if (opts?.includeAuthrite && auth.nonce && auth.authriteSignature) {
    headers['X-BRC103-Identity'] = auth.identityKey
    headers['X-BRC103-Timestamp'] = String(auth.timestamp)
    headers['X-BRC103-Nonce'] = auth.nonce
    headers['X-BRC103-Signature'] = auth.authriteSignature
  }
  return headers
}

/** Sign immediately before fetch — never reuse the result across retries. */
export function freshMessageboxAuthHeaders(args: {
  rootKeyHex: string
  method: MessageboxMethod
  messageBox?: string
  includeAuthrite?: boolean
}): Record<string, string> {
  return messageboxAuthHeaders(
    signMessageboxAuth({
      rootKeyHex: args.rootKeyHex,
      method: args.method,
      messageBox: args.messageBox,
      timestamp: Date.now(),
    }),
    { includeAuthrite: args.includeAuthrite },
  )
}

/** Local verify (tests). Server uses @noble/secp256k1. */
export function verifyMessageboxAuth(args: {
  identityKey: string
  method: MessageboxMethod
  messageBox: string
  timestamp: number
  signature: string
  now?: number
}): boolean {
  const now = args.now ?? Date.now()
  if (!/^[0-9a-f]{66}$/i.test(args.identityKey)) return false
  if (!Number.isFinite(args.timestamp)) return false
  if (Math.abs(now - args.timestamp) > MESSAGEBOX_AUTH_MAX_SKEW_MS) return false
  try {
    const compact = Utils.toArray(args.signature, 'hex')
    if (compact.length !== 64) return false
    const sig = new Signature(
      new BigNumber(Utils.toHex(compact.slice(0, 32)), 16),
      new BigNumber(Utils.toHex(compact.slice(32, 64)), 16),
    )
    const preimage = messageboxAuthPreimage({
      method: args.method,
      messageBox: args.messageBox,
      timestamp: args.timestamp,
    })
    return PublicKey.fromString(args.identityKey).verify(
      Utils.toArray(preimage, 'utf8'),
      sig,
    )
  } catch {
    return false
  }
}

export function verifyMessageboxAuthrite(args: {
  identityKey: string
  method: MessageboxMethod
  messageBox: string
  timestamp: number
  nonce: string
  signature: string
  now?: number
}): boolean {
  const now = args.now ?? Date.now()
  if (!/^[0-9a-f]{66}$/i.test(args.identityKey)) return false
  if (!args.nonce?.trim()) return false
  if (!Number.isFinite(args.timestamp)) return false
  if (Math.abs(now - args.timestamp) > MESSAGEBOX_AUTH_MAX_SKEW_MS) return false
  try {
    const compact = Utils.toArray(args.signature, 'hex')
    if (compact.length !== 64) return false
    const sig = new Signature(
      new BigNumber(Utils.toHex(compact.slice(0, 32)), 16),
      new BigNumber(Utils.toHex(compact.slice(32, 64)), 16),
    )
    const preimage = messageboxAuthritePreimage({
      method: args.method,
      messageBox: args.messageBox,
      timestamp: args.timestamp,
      nonce: args.nonce,
    })
    return PublicKey.fromString(args.identityKey).verify(
      Utils.toArray(preimage, 'utf8'),
      sig,
    )
  } catch {
    return false
  }
}
