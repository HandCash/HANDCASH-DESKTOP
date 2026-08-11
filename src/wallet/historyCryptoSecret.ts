/**
 * Deterministic BRC-39 crypto secret from the wallet root key.
 * History follows keys — not the device unlock password.
 */
import { Hash, Utils } from '@bsv/sdk'

const LABEL = 'handcash.brc39.v2'

function normalizeRootKeyHex(rootKeyHex: string): string {
  const s = rootKeyHex.trim().replace(/^0x/i, '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(s)) {
    throw new Error('Root key must be 64 hex characters')
  }
  return s
}

/**
 * Stable string fed into toolbox encryptBRC39 / importBRC39 as the "password".
 * Labeled SHA-256 so we never pass the raw root key into Argon2 / worker logs.
 */
export function historyCryptoSecret(rootKeyHex: string): string {
  const hex = normalizeRootKeyHex(rootKeyHex)
  const material = Utils.toArray(`${LABEL}|${hex}`, 'utf8')
  const digest = Hash.sha256(material)
  return Utils.toHex(digest)
}
