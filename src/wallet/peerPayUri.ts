import { PublicKey } from '@bsv/sdk'

/**
 * BRC-125 — PeerPay URI scheme for BRC-29-style identity-key payments.
 * @see https://bsv.brc.dev/payments/0125.md
 *
 * Format: peerpay:<66-hex-compressed-pubkey>[?sats=<n>]
 */

export type PeerPayUri = {
  identityKey: string
  /** Satoshis when present and > 0; otherwise unspecified. */
  sats: number | null
}

const IDENTITY_KEY_RE = /^(02|03)[0-9a-f]{64}$/

export function isCompressedIdentityKeyHex(value: string): boolean {
  return IDENTITY_KEY_RE.test(value.trim().toLowerCase())
}

export function buildPeerPayUri(identityKey: string, sats?: number | null): string {
  const key = identityKey.trim().toLowerCase()
  if (!isCompressedIdentityKeyHex(key)) {
    throw new Error('Identity key must be a 33-byte compressed secp256k1 public key (66 hex)')
  }
  // Validate curve point.
  PublicKey.fromString(key)
  const amount =
    sats != null && Number.isFinite(sats) && Math.trunc(sats) > 0
      ? Math.trunc(sats)
      : null
  return amount != null ? `peerpay:${key}?sats=${amount}` : `peerpay:${key}`
}

/** True if the string looks like a peerpay URI (case-insensitive scheme). */
export function looksLikePeerPayUri(raw: string): boolean {
  return /^peerpay:/i.test(raw.trim())
}

export function parsePeerPayUri(raw: string): PeerPayUri {
  const trimmed = raw.trim()
  if (!/^peerpay:/i.test(trimmed)) {
    throw new Error('Not a peerpay URI')
  }
  const withoutScheme = trimmed.replace(/^peerpay:/i, '')
  const q = withoutScheme.indexOf('?')
  const keyPart = (q >= 0 ? withoutScheme.slice(0, q) : withoutScheme).trim().toLowerCase()
  const query = q >= 0 ? withoutScheme.slice(q + 1) : ''

  if (!isCompressedIdentityKeyHex(keyPart)) {
    throw new Error('peerpay URI identity key is invalid')
  }
  PublicKey.fromString(keyPart)

  let sats: number | null = null
  if (query) {
    for (const part of query.split('&')) {
      const eq = part.indexOf('=')
      if (eq < 0) continue
      const name = decodeURIComponent(part.slice(0, eq)).toLowerCase()
      const value = decodeURIComponent(part.slice(eq + 1))
      if (name !== 'sats') continue
      if (!/^\d+$/.test(value)) throw new Error('peerpay sats must be a non-negative integer')
      const n = Number.parseInt(value, 10)
      sats = n > 0 ? n : null
    }
  }

  return { identityKey: keyPart, sats }
}

/**
 * If `raw` is a peerpay URI, return its identity key (and optional sats).
 * Otherwise return null (caller should try address / bare identity key).
 */
export function tryParsePeerPayUri(raw: string): PeerPayUri | null {
  if (!looksLikePeerPayUri(raw)) return null
  try {
    return parsePeerPayUri(raw)
  } catch {
    return null
  }
}
