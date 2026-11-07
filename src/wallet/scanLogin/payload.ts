/**
 * Scan-to-login QR: shown by the new device, scanned by a signed-in one.
 *
 * It carries a one-time pairing secret and the new device's one-time public
 * key. The secret never crosses the network: each request proves it with an
 * HMAC, and the vault is encrypted to the key from the QR, so the local network
 * sees only ciphertext.
 */
import { Hash, Utils } from '@bsv/sdk'

export const SCAN_LOGIN_KIND = 'handcash-scan-login'
export const SCAN_LOGIN_TTL_MS = 10 * 60_000

export type ScanLoginPayload = {
  kind: typeof SCAN_LOGIN_KIND
  v: 1
  /** The new device's peer server, one per local address; empty when only the relay applies. */
  urls: string[]
  loginKey: string
  secret: string
  label: string
  expiresAt: number
}

const isPublicKey = (value: unknown): value is string =>
  typeof value === 'string' && /^(02|03)[0-9a-f]{64}$/i.test(value)

export function scanLoginQrText(payload: ScanLoginPayload): string {
  return JSON.stringify(payload)
}

export function tryParseScanLoginPayload(raw: string, now = Date.now()): ScanLoginPayload | null {
  const text = raw.trim()
  if (!text.startsWith('{') || !text.includes(SCAN_LOGIN_KIND)) return null
  let o: Record<string, unknown>
  try {
    o = JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
  if (o.kind !== SCAN_LOGIN_KIND || o.v !== 1) return null
  if (!isPublicKey(o.loginKey)) return null
  if (typeof o.secret !== 'string' || !/^[0-9a-f]{64}$/.test(o.secret)) return null
  const urls = Array.isArray(o.urls)
    ? o.urls.filter((u): u is string => typeof u === 'string' && /^http:\/\/[\w.:-]+$/i.test(u)).slice(0, 4)
    : []
  const expiresAt = Number(o.expiresAt)
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null
  const label = typeof o.label === 'string' && o.label.trim() ? o.label.trim().slice(0, 60) : 'New device'
  return { kind: SCAN_LOGIN_KIND, v: 1, urls, loginKey: o.loginKey.toLowerCase(), secret: o.secret, label, expiresAt }
}

/** HMAC over one step of the exchange, keyed by the pairing secret. */
export function scanLoginProof(
  secret: string,
  step: 'hello' | 'vault' | 'refuse',
  subject: string,
): string {
  return Utils.toHex(
    Hash.sha256hmac(Utils.toArray(secret, 'hex'), Utils.toArray(`handcash-scan-login\n${step}\n${subject}`, 'utf8')),
  )
}

/** Digits of the pairing code. It is typed by a person; it is never transported. */
export const PAIRING_CODE_LENGTH = 6
/** Wrong codes allowed before the new device ends the session. */
export const PAIRING_MAX_ATTEMPTS = 3
/** How long a shown code can be typed, counted from the approver reaching the new device. */
export const PAIRING_CODE_TTL_MS = 2 * 60_000

/**
 * Proof that the approver was given the code the new device shows (BRC-249 pairing).
 * Bound to the pairing secret (session), the approver's key (device) and a fresh
 * nonce (no replay). The code itself never goes on the wire.
 */
export function pairingConfirmProof(secret: string, approverKey: string, nonce: string, code: string): string {
  return Utils.toHex(
    Hash.sha256hmac(
      Utils.toArray(secret, 'hex'),
      Utils.toArray(`handcash-scan-login\nconfirm\n${approverKey.toLowerCase()}\n${nonce}\n${code}`, 'utf8'),
    ),
  )
}

export function proofMatches(expected: string, given: unknown): boolean {
  if (typeof given !== 'string' || given.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i)
  return diff === 0
}

/** Receipt binds setup completion to this session, sender and exact encrypted transfer. */
export function pairingReceiptText(loginKey: string, approverKey: string, sealedHash: string): string {
  return `handcash-scan-login\ninstalled\n${loginKey}\n${approverKey}\n${sealedHash}`
}

export function sha256Hex(text: string): string {
  return Utils.toHex(Hash.sha256(Utils.toArray(text, 'utf8')))
}
