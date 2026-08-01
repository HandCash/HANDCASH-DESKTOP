/**
 * BRC-140 — Threshold key sharing via Shamir's Secret Sharing.
 * @see https://bsv.brc.dev/key-derivation/0140.md
 *
 * Uses @bsv/sdk PrivateKey.toBackupShares / fromBackupShares (reference impl).
 * Cloud providers (Google / Apple / Dropbox) are transport only — share text is the BRC.
 */
import { PrivateKey } from '@bsv/sdk'

export const BRC140_DEFAULT_THRESHOLD = 2
export const BRC140_DEFAULT_TOTAL = 3

export type Brc140ShareSet = {
  threshold: number
  totalShares: number
  /** Canonical BRC-140 backup strings (`x.y.threshold.integrity`). */
  shares: string[]
  /** Shared 8-hex integrity tag from HASH160(compressed pubkey). */
  integrity: string
}

export function isBrc140ShareFormat(line: string): boolean {
  const parts = line.trim().split('.')
  if (parts.length !== 4) return false
  const [x, y, t, integrity] = parts
  if (!x || !y || !integrity) return false
  if (!/^[0-9a-f]{8}$/i.test(integrity)) return false
  const threshold = Number.parseInt(t!, 10)
  return Number.isInteger(threshold) && threshold >= 2
}

/** Split the vault root private key into BRC-140 backup shares. */
export function createBrc140Shares(
  rootKeyHex: string,
  threshold: number = BRC140_DEFAULT_THRESHOLD,
  totalShares: number = BRC140_DEFAULT_TOTAL,
): Brc140ShareSet {
  const key = PrivateKey.fromHex(rootKeyHex.trim())
  const shares = key.toBackupShares(threshold, totalShares)
  const integrity = shares[0]?.split('.')[3]
  if (!integrity) throw new Error('Failed to create BRC-140 shares')
  return { threshold, totalShares, shares, integrity }
}

/** Recover root private key hex from ≥ threshold BRC-140 share strings. */
export function recoverRootKeyFromBrc140Shares(shareLines: string[]): {
  rootKeyHex: string
  identityKey: string
  address: string
  integrity: string
  threshold: number
} {
  const shares = shareLines
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('#'))
  if (shares.length < 2) {
    throw new Error('Need at least two BRC-140 shares to recover')
  }
  for (const [i, share] of shares.entries()) {
    if (!isBrc140ShareFormat(share)) {
      throw new Error(`Share ${i + 1} is not valid BRC-140 format`)
    }
  }
  const key = PrivateKey.fromBackupShares(shares)
  const integrity = shares[0]!.split('.')[3]!
  const threshold = Number.parseInt(shares[0]!.split('.')[2]!, 10)
  return {
    rootKeyHex: key.toHex(),
    identityKey: key.toPublicKey().toString(),
    address: key.toAddress(),
    integrity,
    threshold,
  }
}

/** Suggested destinations for a 2-of-3 layout (transport only — not part of BRC-140). */
export const BRC140_DESTINATION_HINTS = [
  'Email to yourself (your mail client)',
  'Password manager / notes',
  'USB, paper, or another device',
] as const

export function shareDownloadFilename(index: number, total: number, integrity: string): string {
  return `handcash-brc140-share-${index + 1}-of-${total}-${integrity.slice(0, 4)}.txt`
}
