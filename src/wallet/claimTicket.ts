/**
 * HMAC claim tickets for BRC-169 handle minting.
 *
 * HandCash proves account ownership (Auth0 + cloud $alias) and issues a short-
 * lived ticket. Desktop presents it to BRC-CLOUD with the wallet identity key.
 * The long-lived secret never leaves the HandCash backend / BRC-CLOUD.
 *
 * Ticket: base64url(payloadJson) + "." + base64url(hmacSha256)
 * Payload: { v:1, handle, identityKey, exp }
 */
const enc = new TextEncoder()

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let bin = ''
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]!)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

export type ClaimTicketPayload = {
  v: 1
  handle: string
  identityKey: string
  exp: number
}

export async function mintClaimTicket(
  secret: string,
  args: { handle: string; identityKey: string; ttlSec?: number },
): Promise<{ ticket: string; exp: number }> {
  const handle = args.handle.trim().toLowerCase().replace(/^\$/, '').replace(/^@/, '')
  const identityKey = args.identityKey.trim().toLowerCase()
  const exp = Math.floor(Date.now() / 1000) + (args.ttlSec ?? 300)
  const payload: ClaimTicketPayload = { v: 1, handle, identityKey, exp }
  const body = b64url(enc.encode(JSON.stringify(payload)))
  const key = await hmacKey(secret)
  const sig = b64url(await crypto.subtle.sign('HMAC', key, enc.encode(body)))
  return { ticket: `${body}.${sig}`, exp }
}

export type TicketVerifyResult =
  | { ok: true; payload: ClaimTicketPayload }
  | { ok: false; error: string }

export async function verifyClaimTicket(
  secret: string,
  ticket: string,
  expected: { handle: string; identityKey: string },
  nowSec = Math.floor(Date.now() / 1000),
): Promise<TicketVerifyResult> {
  const parts = String(ticket || '').split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, error: 'malformed-ticket' }
  }
  const [body, sig] = parts
  const key = await hmacKey(secret)
  const sigBytes = fromB64url(sig)
  const sigBuf = new Uint8Array(sigBytes.byteLength)
  sigBuf.set(sigBytes)
  const valid = await crypto.subtle.verify('HMAC', key, sigBuf, enc.encode(body))
  if (!valid) return { ok: false, error: 'invalid-ticket' }

  let payload: ClaimTicketPayload
  try {
    payload = JSON.parse(new TextDecoder().decode(fromB64url(body))) as ClaimTicketPayload
  } catch {
    return { ok: false, error: 'malformed-ticket' }
  }
  if (payload.v !== 1 || typeof payload.handle !== 'string' || typeof payload.identityKey !== 'string') {
    return { ok: false, error: 'malformed-ticket' }
  }
  if (typeof payload.exp !== 'number' || payload.exp < nowSec) {
    return { ok: false, error: 'ticket-expired' }
  }

  const handle = expected.handle.trim().toLowerCase().replace(/^\$/, '').replace(/^@/, '')
  const identityKey = expected.identityKey.trim().toLowerCase()
  if (payload.handle !== handle) return { ok: false, error: 'ticket-handle-mismatch' }
  if (payload.identityKey !== identityKey) {
    return { ok: false, error: 'ticket-identity-mismatch' }
  }
  return { ok: true, payload }
}
