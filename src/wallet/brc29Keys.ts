import { KeyDeriver, P2PKH, PrivateKey, PublicKey, Random, Utils, type WalletProtocol } from '@bsv/sdk'

/**
 * BRC-29 keys for every output this wallet writes: token value outputs and
 * change (draft BRC-255), IPT holder keys (BRC-253), direct-offer
 * proceeds, fee coins and pads. A fresh prefix per transfer and suffix per
 * output give each output its own child; whoever holds the output derives its
 * private key from the same strings and the sender's identity key.
 *
 * BRC-29 is an ordinary level-2 protocol, so any BRC-100 wallet can derive and
 * sign these keys through `getPublicKey` / `createSignature`. An output on the
 * identity address, or under a `p <scheme>` protocol a wallet does not
 * implement, can only be spent with the raw root key.
 */

export const BRC29_PROTOCOL: WalletProtocol = [2, '3241645161d8']

/** The strings that find one output's key again: BRC-29 `derivationPrefix` / `derivationSuffix` plus the sender. */
export type Remittance = {
  derivationPrefix: string
  derivationSuffix: string
  senderIdentityKey: string
}

const REMITTANCE_RE = /^\S{1,128}$/
const KEY_RE = /^0[23][0-9a-f]{64}$/

export function brc29KeyID(derivationPrefix: string, derivationSuffix: string): string {
  if (!REMITTANCE_RE.test(derivationPrefix) || !REMITTANCE_RE.test(derivationSuffix)) {
    throw new Error('Remittance strings must be nonempty and contain no whitespace')
  }
  return `${derivationPrefix} ${derivationSuffix}`
}

export function freshRemittanceString(): string {
  return Utils.toBase64(Random(12))
}

/** The child public key an output pays: `counterparty`'s, or this wallet's own for `'self'`. */
export function brc29PublicKey(
  root: PrivateKey,
  derivationPrefix: string,
  derivationSuffix: string,
  counterparty: string,
): PublicKey {
  return new KeyDeriver(root).derivePublicKey(BRC29_PROTOCOL, brc29KeyID(derivationPrefix, derivationSuffix), counterparty)
}

/** The child private key of an output this wallet holds under `remittance`. */
export function brc29PrivateKey(root: PrivateKey, remittance: Remittance): PrivateKey {
  return new KeyDeriver(root).derivePrivateKey(
    BRC29_PROTOCOL,
    brc29KeyID(remittance.derivationPrefix, remittance.derivationSuffix),
    remittance.senderIdentityKey,
  )
}

/** A fresh BRC-29 child of this wallet (sender and counterparty both self), with its remittance. */
export function selfBrc29Output(
  active: { rootKeyHex: string; identityKey: string },
  derivationPrefix: string = freshRemittanceString(),
): { address: string; remittance: Remittance; key: PrivateKey } {
  const remittance: Remittance = {
    derivationPrefix,
    derivationSuffix: freshRemittanceString(),
    senderIdentityKey: active.identityKey.toLowerCase(),
  }
  const key = brc29PrivateKey(PrivateKey.fromHex(active.rootKeyHex), remittance)
  return { address: key.toAddress(), remittance, key }
}

/** `customInstructions` JSON with `remittance` written over any earlier one, so the row finds its key again. */
export function withRemittance(customInstructions: string, remittance: Remittance): string {
  let parsed: unknown = {}
  try {
    parsed = JSON.parse(customInstructions)
  } catch {
    /* not JSON: the remittance becomes the whole record */
  }
  const base = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  return JSON.stringify({ ...base, ...remittance })
}

/** The remittance `withRemittance` wrote into a row's `customInstructions`, or null. */
export function remittanceFromInstructions(customInstructions: string | null | undefined): Remittance | null {
  if (!customInstructions) return null
  try {
    return readRemittance(JSON.parse(customInstructions))
  } catch {
    return null
  }
}

const REMITTANCE_TAG = 'brc29:'
const TAG_MAX = 300

/**
 * The remittance as a basket tag, `brc29:<hex prefix>.<hex suffix>.<sender>`.
 * Hex because the toolbox lower-cases tags. Item rows carry it so a listing
 * that never reads `customInstructions` still finds each tip's key. Null when
 * a peer's long strings would not fit a tag; `customInstructions` still holds them.
 */
export function remittanceTag(remittance: Remittance): string | null {
  const hex = (s: string) => Utils.toHex(Utils.toArray(s, 'utf8'))
  const tag = `${REMITTANCE_TAG}${hex(remittance.derivationPrefix)}.${hex(remittance.derivationSuffix)}.${remittance.senderIdentityKey.toLowerCase()}`
  return tag.length <= TAG_MAX ? tag : null
}

/** The remittance a row's `brc29:` tag records, or null when it has none. */
export function remittanceFromTags(tags: readonly string[] | undefined): Remittance | null {
  const tag = tags?.find((t) => t.startsWith(REMITTANCE_TAG))
  if (!tag) return null
  const [prefixHex, suffixHex, sender] = tag.slice(REMITTANCE_TAG.length).split('.')
  if (!prefixHex || !suffixHex || !/^[0-9a-f]+$/.test(prefixHex + suffixHex)) return null
  try {
    return readRemittance({
      derivationPrefix: Utils.toUTF8(Utils.toArray(prefixHex, 'hex')),
      derivationSuffix: Utils.toUTF8(Utils.toArray(suffixHex, 'hex')),
      senderIdentityKey: sender,
    })
  } catch {
    return null
  }
}

/** BRC-251 `meta.asset.remittance`: the sender, and the strings of each output paying the recipient. */
export type DeliveryRemittance = {
  senderIdentityKey: string
  outputs: { vout: number; derivationPrefix: string; derivationSuffix: string }[]
}

/** Each well-formed output of a delivery remittance, keyed by vout. Malformed entries are dropped. */
export function readDeliveryRemittance(value: unknown): Map<number, Remittance> {
  const out = new Map<number, Remittance>()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  const v = value as { senderIdentityKey?: unknown; outputs?: unknown }
  if (!Array.isArray(v.outputs)) return out
  for (const row of v.outputs.slice(0, 64)) {
    const vout = (row as { vout?: unknown } | null)?.vout
    if (!Number.isSafeInteger(vout) || (vout as number) < 0) continue
    const remittance = readRemittance({ ...(row as object), senderIdentityKey: v.senderIdentityKey })
    if (remittance) out.set(vout as number, remittance)
  }
  return out
}

/** The remittance members of a parsed object, or null when any is missing or malformed. */
export function readRemittance(value: unknown): Remittance | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  const prefix = v.derivationPrefix
  const suffix = v.derivationSuffix
  const sender = typeof v.senderIdentityKey === 'string' ? v.senderIdentityKey.trim().toLowerCase() : ''
  if (typeof prefix !== 'string' || typeof suffix !== 'string') return null
  if (!REMITTANCE_RE.test(prefix) || !REMITTANCE_RE.test(suffix) || !KEY_RE.test(sender)) return null
  return { derivationPrefix: prefix, derivationSuffix: suffix, senderIdentityKey: sender }
}

/**
 * A plain P2PKH output on a fresh BRC-29 self child (fee coins, pads), its
 * remittance in `customInstructions` and a `brc29:` tag.
 */
export function selfP2pkhOutput(
  active: { rootKeyHex: string; identityKey: string },
  tags: string[],
  child: { address: string; remittance: Remittance } = selfBrc29Output(active),
): { lockingScript: string; customInstructions: string; tags: string[] } {
  const tag = remittanceTag(child.remittance)
  return {
    lockingScript: new P2PKH().lock(child.address).toHex(),
    customInstructions: withRemittance('', child.remittance),
    tags: tag ? [...tags, tag] : tags,
  }
}

/**
 * The key a held P2PKH row is locked to: its BRC-29 child, or the root key for
 * a row written to the identity address before BRC-29. Null when neither matches.
 */
export function heldP2pkhSigningKey(
  active: { rootKeyHex: string; address: string },
  row: { lockingScript?: string; tags?: readonly string[]; customInstructions?: string | null },
): PrivateKey | null {
  const lock = (row.lockingScript ?? '').toLowerCase()
  if (!lock) return null
  const root = PrivateKey.fromHex(active.rootKeyHex)
  const remittance = remittanceFromTags(row.tags) ?? remittanceFromInstructions(row.customInstructions)
  if (remittance) {
    try {
      const child = brc29PrivateKey(root, remittance)
      if (new P2PKH().lock(child.toAddress()).toHex().toLowerCase() === lock) return child
    } catch {
      /* a remittance this wallet cannot derive names no key of ours */
    }
  }
  return new P2PKH().lock(active.address).toHex().toLowerCase() === lock ? root : null
}
