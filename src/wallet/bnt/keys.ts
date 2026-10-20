import { KeyDeriver, PrivateKey, PublicKey, Random, Utils } from '@bsv/sdk'

/**
 * BRC-255 keys. The issuer key is the identity key's child for `[2, "bnt
 * issuer"]`, key ID `1`, counterparty `anyone`, so anyone derives it from
 * `iss` (§3). Holder keys are fresh `[2, "bnt holder"]` children per output
 * (§10). Fee coins use fresh `[2, "bnt fee"]` children of this wallet, so
 * paying a fee never links two transfers or names an identity.
 */

export const BNT_ISSUER_PROTOCOL: [2, string] = [2, 'bnt issuer']
export const BNT_HOLDER_PROTOCOL: [2, string] = [2, 'bnt holder']
export const BNT_FEE_PROTOCOL: [2, string] = [2, 'bnt fee']
const ISSUER_KEY_ID = '1'
const ANYONE = new PrivateKey(1)
const KEY_RE = /^0[23][0-9a-f]{64}$/

/** The clause key an identity's assets name, derivable by anyone. */
export function bntIssuerKeyOf(identityKeyHex: string): string {
  const identity = identityKeyHex.trim().toLowerCase()
  if (!KEY_RE.test(identity)) throw new Error('An issuer identity is a compressed public key')
  return PublicKey.fromString(identity)
    .deriveChild(ANYONE, `${BNT_ISSUER_PROTOCOL[0]}-${BNT_ISSUER_PROTOCOL[1]}-${ISSUER_KEY_ID}`)
    .toString()
}

/** This wallet's own issuer private key. */
export function bntIssuerPrivateKey(root: PrivateKey): PrivateKey {
  return new KeyDeriver(root).derivePrivateKey(BNT_ISSUER_PROTOCOL, ISSUER_KEY_ID, 'anyone')
}

export function freshDerivationString(): string {
  return Utils.toBase64(Random(12))
}

/** Remittance of one held output: the holder derives its key from these and the sender's identity. */
export type BntRemittance = { derivationPrefix: string; derivationSuffix: string; senderIdentityKey: string }

function holderKeyId(prefix: string, suffix: string): string {
  if (!prefix || !suffix || prefix.length > 64 || suffix.length > 64 || /\s/.test(prefix + suffix)) {
    throw new Error('A holder key needs a derivation prefix and suffix')
  }
  return `${prefix} ${suffix}`
}

/** The holder key a sender writes for `recipient` (an identity key, or this wallet's own). */
export function bntHolderPublicKey(senderRoot: PrivateKey, recipient: string, prefix: string, suffix: string): string {
  const self = senderRoot.toPublicKey().toString()
  const who = recipient.trim().toLowerCase()
  const deriver = new KeyDeriver(senderRoot)
  const keyId = holderKeyId(prefix, suffix)
  if (who === self) return deriver.derivePrivateKey(BNT_HOLDER_PROTOCOL, keyId, 'self').toPublicKey().toString()
  if (!KEY_RE.test(who)) throw new Error('A recipient is an identity key')
  return deriver.derivePublicKey(BNT_HOLDER_PROTOCOL, keyId, who, false).toString()
}

/** The private key of an output this wallet holds under `remittance`. */
export function bntHolderPrivateKey(root: PrivateKey, remittance: BntRemittance): PrivateKey {
  const sender = remittance.senderIdentityKey.trim().toLowerCase()
  if (!KEY_RE.test(sender)) throw new Error('The remittance names no sender identity')
  const keyId = holderKeyId(remittance.derivationPrefix, remittance.derivationSuffix)
  const self = root.toPublicKey().toString()
  return new KeyDeriver(root).derivePrivateKey(BNT_HOLDER_PROTOCOL, keyId, sender === self ? 'self' : sender)
}

export function readBntRemittance(value: unknown): BntRemittance | null {
  const r = value as Partial<BntRemittance> | null
  if (!r || typeof r !== 'object') return null
  const { derivationPrefix, derivationSuffix, senderIdentityKey } = r
  if (typeof derivationPrefix !== 'string' || typeof derivationSuffix !== 'string' || typeof senderIdentityKey !== 'string') return null
  try {
    holderKeyId(derivationPrefix, derivationSuffix)
  } catch {
    return null
  }
  const sender = senderIdentityKey.trim().toLowerCase()
  return KEY_RE.test(sender) ? { derivationPrefix, derivationSuffix, senderIdentityKey: sender } : null
}

/** A fee coin key: a fresh self child, its key ID kept on the coin's row. */
export function bntFeePrivateKey(root: PrivateKey, keyId: string): PrivateKey {
  if (!keyId || keyId.length > 64) throw new Error('A fee key ID is 1 to 64 characters')
  return new KeyDeriver(root).derivePrivateKey(BNT_FEE_PROTOCOL, keyId, 'self')
}
