import { KeyDeriver, PrivateKey, PublicKey, Random, Utils, type WalletProtocol } from '@bsv/sdk'

/**
 * BRC-207 `p color` key derivation, shared by P2P-FT (BRC-251) value outputs
 * and countersigned holder keys. A fresh prefix per transfer and suffix per
 * output give every output its own key; the recipient derives the private key
 * from the same strings and the sender's identity key.
 */
export type ColorRemittance = {
  derivationPrefix: string
  derivationSuffix: string
  senderIdentityKey: string
}

export const COLOR_KEY_ID = 'color'

const MAX_PROTOCOL_NAME = 280
const REMITTANCE_RE = /^\S{1,128}$/
const KEY_RE = /^0[23][0-9a-f]{64}$/
const ASSET_RE = /^([0-9a-f]{64})_(0|[1-9]\d*)$/

function utf8Hex(value: string): string {
  return Utils.toHex(Utils.toArray(value, 'utf8'))
}

/** `<txid>v<vout>`, or `issue` for a deploy whose id does not exist yet. */
export function colorAssetTag(assetId: string): string {
  if (assetId === 'ISSUE') return 'issue'
  const match = ASSET_RE.exec(assetId.trim().toLowerCase().replace('.', '_'))
  if (!match) throw new Error(`Invalid asset id for p color derivation: ${assetId}`)
  return `${match[1]}v${match[2]}`
}

export function colorProtocol(assetId: string, derivationPrefix: string, derivationSuffix: string): WalletProtocol {
  if (!REMITTANCE_RE.test(derivationPrefix) || !REMITTANCE_RE.test(derivationSuffix)) {
    throw new Error('Remittance strings must be nonempty and contain no whitespace')
  }
  const name = `p color ${colorAssetTag(assetId)} ${utf8Hex(derivationPrefix)} ${utf8Hex(derivationSuffix)}`
  if (name.length > MAX_PROTOCOL_NAME) throw new Error('p color protocol name is too long')
  return [2, name]
}

export function freshRemittanceString(): string {
  return Utils.toBase64(Random(12))
}

/** The child public key an output pays: the recipient's, or this wallet's own for `'self'`. */
export function colorPublicKey(
  root: PrivateKey,
  assetId: string,
  derivationPrefix: string,
  derivationSuffix: string,
  counterparty: string,
): PublicKey {
  return new KeyDeriver(root).derivePublicKey(
    colorProtocol(assetId, derivationPrefix, derivationSuffix),
    COLOR_KEY_ID,
    counterparty,
  )
}

/** The child private key of an output this wallet received under `remittance`. */
export function colorPrivateKey(root: PrivateKey, assetId: string, remittance: ColorRemittance): PrivateKey {
  return new KeyDeriver(root).derivePrivateKey(
    colorProtocol(assetId, remittance.derivationPrefix, remittance.derivationSuffix),
    COLOR_KEY_ID,
    remittance.senderIdentityKey,
  )
}

/** BRC-251 `meta.asset.remittance`: the sender, and the strings of each output paying the recipient. */
export type DeliveryRemittance = {
  senderIdentityKey: string
  outputs: { vout: number; derivationPrefix: string; derivationSuffix: string }[]
}

/** Each well-formed output of a delivery remittance, keyed by vout. Malformed entries are dropped. */
export function readDeliveryRemittance(value: unknown): Map<number, ColorRemittance> {
  const out = new Map<number, ColorRemittance>()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  const v = value as { senderIdentityKey?: unknown; outputs?: unknown }
  if (!Array.isArray(v.outputs)) return out
  for (const row of v.outputs.slice(0, 64)) {
    const vout = (row as { vout?: unknown } | null)?.vout
    if (!Number.isSafeInteger(vout) || (vout as number) < 0) continue
    const remittance = readColorRemittance({ ...(row as object), senderIdentityKey: v.senderIdentityKey })
    if (remittance) out.set(vout as number, remittance)
  }
  return out
}

/** The remittance members of a parsed object, or null when any is missing or malformed. */
export function readColorRemittance(value: unknown): ColorRemittance | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  const prefix = v.derivationPrefix
  const suffix = v.derivationSuffix
  const sender = typeof v.senderIdentityKey === 'string' ? v.senderIdentityKey.trim().toLowerCase() : ''
  if (typeof prefix !== 'string' || typeof suffix !== 'string') return null
  if (!REMITTANCE_RE.test(prefix) || !REMITTANCE_RE.test(suffix) || !KEY_RE.test(sender)) return null
  return { derivationPrefix: prefix, derivationSuffix: suffix, senderIdentityKey: sender }
}
