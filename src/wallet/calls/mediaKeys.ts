/**
 * Media keys for one call, agreed between the two identity keys and nothing
 * else: each side asks its wallet for an HMAC under the BRC-42 key it shares
 * with the other identity (the derivation is symmetric, so both get the same
 * 32 bytes and nobody else can). From that secret come one AES-GCM key per
 * direction, and a safety code over the secret and both DTLS fingerprints:
 * the same code on both screens means the right person and nobody in between.
 */

import type { WalletInterface } from '@bsv/sdk'

const PROTOCOL: [2, string] = [2, 'handcash call media']
const SALT = new TextEncoder().encode('hc-call/1')
const SAFETY_DIGITS = 12

export type CallKeys = { send: CryptoKey; receive: CryptoKey }

/** The 32 bytes this identity and `peer` share for `callId`. */
export async function callSecret(
  wallet: Pick<WalletInterface, 'createHmac'>,
  peer: string,
  callId: string,
): Promise<Uint8Array> {
  const { hmac } = await wallet.createHmac({
    data: Array.from(new TextEncoder().encode(`hc-call/1 media ${callId}`)),
    protocolID: PROTOCOL,
    keyID: callId,
    counterparty: peer,
  })
  return Uint8Array.from(hmac)
}

function hkdf(secret: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', Uint8Array.from(secret), 'HKDF', false, ['deriveKey', 'deriveBits'])
}

function directionKey(base: CryptoKey, from: string, to: string, callId: string): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: SALT, info: new TextEncoder().encode(`media ${from} ${to} ${callId}`) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** What this side seals with, and what it opens the far side's frames with. */
export async function callKeys(secret: Uint8Array, self: string, peer: string, callId: string): Promise<CallKeys> {
  const base = await hkdf(secret)
  const [send, receive] = await Promise.all([
    directionKey(base, self, peer, callId),
    directionKey(base, peer, self, callId),
  ])
  return { send, receive }
}

/** Twelve digits in groups of four, the same on both sides of an untouched call. */
export async function safetyCode(secret: Uint8Array, callId: string, fingerprints: [string, string]): Promise<string> {
  const pair = [...fingerprints].map((f) => f.toLowerCase()).sort().join(' ')
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: SALT, info: new TextEncoder().encode(`safety ${callId} ${pair}`) },
    await hkdf(secret),
    64,
  )
  let n = 0n
  for (const b of new Uint8Array(bits)) n = (n << 8n) | BigInt(b)
  const digits = (n % 10n ** BigInt(SAFETY_DIGITS)).toString().padStart(SAFETY_DIGITS, '0')
  return digits.match(/.{4}/g)!.join(' ')
}
