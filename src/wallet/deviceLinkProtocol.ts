/**
 * Device-link pairing (Telegram-style) — shared wire format with HANDCASH-MOBILE.
 */

export const PAIRING_QR_PREFIX = 'handcash-link:'

export type PairingOffer = {
  v: 1
  baseUrl: string
  sessionId: string
  keyHex: string
  expiresAt: number
  handle?: string
}

export type PairingPackage = {
  v: 1
  rootKeyHex: string
  handle: string
  identityKey: string
  address: string
  chain: 'main' | 'test'
  historyBackupBaseUrl: string
  createdAt: number
}

export function encodePairingQr(offer: PairingOffer): string {
  return `${PAIRING_QR_PREFIX}${btoa(JSON.stringify(offer))}`
}

export function decodePairingQr(raw: string): PairingOffer {
  const text = raw.trim()
  if (!text.startsWith(PAIRING_QR_PREFIX)) throw new Error('Not a HandCash link QR')
  const offer = JSON.parse(atob(text.slice(PAIRING_QR_PREFIX.length))) as PairingOffer
  if (offer.v !== 1 || !offer.baseUrl || !offer.sessionId || !offer.keyHex) {
    throw new Error('Invalid link payload')
  }
  if (offer.expiresAt < Date.now()) throw new Error('Link QR expired')
  return offer
}

function toBuf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

export function randomKeyHex(bytes = 32): string {
  const arr = crypto.getRandomValues(new Uint8Array(bytes))
  return [...arr].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().replace(/^0x/i, '')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function encryptPairingPackage(
  pkg: PairingPackage,
  keyHex: string,
): Promise<{ ivHex: string; ciphertextHex: string }> {
  const keyBytes = hexToBytes(keyHex)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await crypto.subtle.importKey('raw', toBuf(keyBytes), 'AES-GCM', false, [
    'encrypt',
  ])
  const plain = new TextEncoder().encode(JSON.stringify(pkg))
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain)
  return {
    ivHex: bytesToHex(iv),
    ciphertextHex: bytesToHex(new Uint8Array(cipher)),
  }
}
