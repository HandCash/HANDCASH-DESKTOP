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
  /** The new device's peer server, one per local address. */
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
  if (urls.length === 0) return null
  const expiresAt = Number(o.expiresAt)
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null
  const label = typeof o.label === 'string' && o.label.trim() ? o.label.trim().slice(0, 60) : 'New device'
  return { kind: SCAN_LOGIN_KIND, v: 1, urls, loginKey: o.loginKey.toLowerCase(), secret: o.secret, label, expiresAt }
}

/** HMAC over one step of the exchange, keyed by the pairing secret. */
export function scanLoginProof(secret: string, step: 'hello' | 'vault' | 'refuse', subject: string): string {
  return Utils.toHex(
    Hash.sha256hmac(Utils.toArray(secret, 'hex'), Utils.toArray(`handcash-scan-login\n${step}\n${subject}`, 'utf8')),
  )
}

export function proofMatches(expected: string, given: unknown): boolean {
  if (typeof given !== 'string' || given.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i)
  return diff === 0
}

export function sha256Hex(text: string): string {
  return Utils.toHex(Hash.sha256(Utils.toArray(text, 'utf8')))
}

/** 6 digits both screens show: bound to the secret, the new device's key and the approver's key. */
export function scanLoginCode(secret: string, loginKey: string, approverKey: string): string {
  const digest = Hash.sha256(
    Utils.toArray(`handcash-scan-login-code\n${secret}\n${loginKey.toLowerCase()}\n${approverKey.toLowerCase()}`, 'utf8'),
  )
  const n = ((digest[0]! << 24) | (digest[1]! << 16) | (digest[2]! << 8) | digest[3]!) >>> 0
  return String(n % 1_000_000).padStart(6, '0')
}
