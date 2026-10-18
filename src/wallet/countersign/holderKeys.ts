import { Hash, KeyDeriver, PrivateKey, ProtoWallet, PublicKey, Utils, type WalletProtocol } from '@bsv/sdk'
import {
  BRC29_PROTOCOL,
  brc29KeyID,
  brc29PrivateKey,
  brc29PublicKey,
  freshRemittanceString,
  heldKeyCandidates,
  readRemittance,
  type Remittance,
} from '../brc29Keys'
import { LEGACY_COLOR_KEY_ID, legacyColorPrivateKey, legacyColorProtocol, legacyColorPublicKey } from '../legacyColorKeys'

/**
 * BRC-253 holder keys: every countersigned output is held under a BRC-29
 * child, never an identity key, so any BRC-100 wallet can sign as holder. A
 * transfer draws one prefix and a suffix per output; the acceptor learns who
 * is behind each output from a BRC-69 specific linkage encrypted to it
 * (BRC-72), and the recipient derives its key from the delivery's remittance.
 *
 * Transfers planned by earlier releases carry no `keyScheme` and hold under
 * `p color` children; they finish on those keys and nothing new is written
 * there.
 */

export type HolderKeyScheme = 'brc29' | 'legacy-color'

/** One output of a transfer: who holds it and its suffix under the transfer's prefix. */
export type HolderOutput = { vout: number; identityKey: string; derivationSuffix: string }

/** The remittance a sender keeps for one transfer, enough to rebuild every request and delivery. */
export type HolderRemittance = { prefix: string; outputs: HolderOutput[]; keyScheme?: 'brc29' }

/** One `recipients` entry of a request. Entries without linkage name an identity-key holder. */
export type RecipientEntry = {
  vout: number
  identityKey: string
  derivationPrefix?: string
  derivationSuffix?: string
  encryptedLinkage?: string
  encryptedLinkageProof?: string
  keyScheme?: 'brc29'
}

/** Rows of the delivery remittance, as `meta`-style `outputs`. */
export type DeliveryOutput = { vout: number; derivationPrefix: string; derivationSuffix: string }

const KEY_RE = /^0[23][0-9a-f]{64}$/
const MAX_RECIPIENTS = 64

function hash160Hex(key: PublicKey): string {
  return Utils.toHex(Hash.hash160(key.encode(true) as number[]))
}

function underscore(outpoint: string): string {
  return outpoint.trim().toLowerCase().replace('.', '_')
}

export function holderKeyScheme(remittance: Pick<HolderRemittance, 'keyScheme'> | Pick<RecipientEntry, 'keyScheme'>): HolderKeyScheme {
  return remittance.keyScheme === 'brc29' ? 'brc29' : 'legacy-color'
}

/** The asset a legacy holder key derives under: a deploy output keeps `ISSUE` after its id is fixed. */
export function holderKeyAsset(assetId: string, outpoint: string): string {
  return underscore(outpoint) === underscore(assetId) ? 'ISSUE' : assetId
}

/** A fresh transfer remittance: one prefix, one suffix per output, BRC-29 keys. */
export function planHolderRemittance(outputs: ReadonlyArray<{ vout: number; identityKey: string }>): HolderRemittance {
  return {
    prefix: freshRemittanceString(),
    outputs: outputs.map((o) => ({
      vout: o.vout,
      identityKey: o.identityKey.toLowerCase(),
      derivationSuffix: freshRemittanceString(),
    })),
    keyScheme: 'brc29',
  }
}

/** The holder pubkey hash of one output: the named identity's child under the transfer's scheme. */
export function holderPkhFor(root: PrivateKey, assetId: string, remittance: HolderRemittance, output: HolderOutput): string {
  return hash160Hex(
    holderKeyScheme(remittance) === 'brc29'
      ? brc29PublicKey(root, remittance.prefix, output.derivationSuffix, output.identityKey)
      : legacyColorPublicKey(root, assetId, remittance.prefix, output.derivationSuffix, output.identityKey),
  )
}

/** The private key of an output this wallet holds under `remittance` in a transfer of `scheme`. */
export function holderPrivateKey(root: PrivateKey, assetId: string, remittance: Remittance, scheme: HolderKeyScheme): PrivateKey {
  return scheme === 'brc29' ? brc29PrivateKey(root, remittance) : legacyColorPrivateKey(root, assetId, remittance)
}

/** The key among every scheme `remittance` may name whose pubkey hash is `holderPkhHex`, or null. */
export function heldHolderKey(root: PrivateKey, assetId: string, remittance: Remittance, holderPkhHex: string): PrivateKey | null {
  const want = holderPkhHex.toLowerCase()
  return heldKeyCandidates(root, assetId, remittance).find((k) => hash160Hex(k.toPublicKey()) === want) ?? null
}

/** The remittance recorded on one held output (`customInstructions`), or null for an identity-key holding. */
export function holderRemittanceOf(customInstructions: unknown): Remittance | null {
  let parsed: unknown = customInstructions
  if (typeof customInstructions === 'string') {
    try {
      parsed = JSON.parse(customInstructions)
    } catch {
      return null
    }
  }
  return readRemittance(parsed)
}

function linkageRequest(scheme: HolderKeyScheme, assetId: string, prefix: string, suffix: string): { protocolID: WalletProtocol; keyID: string } {
  return scheme === 'brc29'
    ? { protocolID: BRC29_PROTOCOL, keyID: brc29KeyID(prefix, suffix) }
    : { protocolID: legacyColorProtocol(assetId, prefix, suffix), keyID: LEGACY_COLOR_KEY_ID }
}

/** A request's `recipients` entry for one output, with its linkage encrypted to `verifier`. */
export async function recipientEntry(
  root: PrivateKey,
  assetId: string,
  remittance: HolderRemittance,
  output: HolderOutput,
  verifier: string,
): Promise<RecipientEntry> {
  const scheme = holderKeyScheme(remittance)
  const revealed = await new ProtoWallet(root).revealSpecificKeyLinkage({
    counterparty: output.identityKey,
    verifier,
    ...linkageRequest(scheme, assetId, remittance.prefix, output.derivationSuffix),
  })
  return {
    vout: output.vout,
    identityKey: output.identityKey,
    derivationPrefix: remittance.prefix,
    derivationSuffix: output.derivationSuffix,
    encryptedLinkage: Utils.toBase64(revealed.encryptedLinkage),
    encryptedLinkageProof: Utils.toBase64(revealed.encryptedLinkageProof),
    ...(scheme === 'brc29' ? { keyScheme: 'brc29' as const } : {}),
  }
}

/** Every entry of a request for `verifier`. */
export function recipientEntries(
  root: PrivateKey,
  assetId: string,
  remittance: HolderRemittance,
  verifier: string,
): Promise<RecipientEntry[]> {
  return Promise.all(remittance.outputs.map((o) => recipientEntry(root, assetId, remittance, o, verifier)))
}

/** Well-formed request entries, at most one per vout. */
export function readRecipientEntries(value: unknown): RecipientEntry[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<number>()
  const out: RecipientEntry[] = []
  for (const row of value.slice(0, MAX_RECIPIENTS)) {
    const r = row as Partial<RecipientEntry> | null
    const identityKey = typeof r?.identityKey === 'string' ? r.identityKey.trim().toLowerCase() : ''
    if (!r || !Number.isSafeInteger(r.vout) || (r.vout as number) < 0 || seen.has(r.vout!) || !KEY_RE.test(identityKey)) continue
    seen.add(r.vout!)
    const linked =
      typeof r.derivationPrefix === 'string' &&
      typeof r.derivationSuffix === 'string' &&
      typeof r.encryptedLinkage === 'string' &&
      typeof r.encryptedLinkageProof === 'string'
    out.push({
      vout: r.vout!,
      identityKey,
      ...(linked
        ? {
            derivationPrefix: r.derivationPrefix,
            derivationSuffix: r.derivationSuffix,
            encryptedLinkage: r.encryptedLinkage,
            encryptedLinkageProof: r.encryptedLinkageProof,
            ...(r.keyScheme === 'brc29' ? { keyScheme: 'brc29' as const } : {}),
          }
        : {}),
    })
  }
  return out
}

/**
 * The holder pubkey hash an entry proves, as the acceptor sees it: decrypt
 * the linkage the prover sent and take `identityKey + linkage·G`. An entry
 * without linkage names an identity-key holder (the earliest revision). Null
 * when the linkage does not decrypt or is not a scalar.
 */
export function provenRecipientPkh(
  acceptorRoot: PrivateKey,
  prover: string,
  assetId: string,
  entry: RecipientEntry,
): string | null {
  const identity = PublicKey.fromString(entry.identityKey)
  if (!entry.encryptedLinkage || !entry.derivationPrefix || !entry.derivationSuffix) return hash160Hex(identity)
  try {
    const { protocolID, keyID } = linkageRequest(holderKeyScheme(entry), assetId, entry.derivationPrefix, entry.derivationSuffix)
    const key = new KeyDeriver(acceptorRoot).deriveSymmetricKey(
      [2, `specific linkage revelation ${protocolID[0]} ${protocolID[1]}`],
      keyID,
      prover,
    )
    const linkage = key.decrypt(Utils.toArray(entry.encryptedLinkage, 'base64')) as number[]
    if (linkage.length !== 32) return null
    return hash160Hex(new PublicKey(identity.add(new PrivateKey(linkage).toPublicKey())))
  } catch {
    return null
  }
}

/** The delivery remittance for one recipient: the outputs it holds in this transfer. */
export function deliveryOutputsFor(remittance: HolderRemittance, recipient: string): DeliveryOutput[] {
  const who = recipient.toLowerCase()
  return remittance.outputs
    .filter((o) => o.identityKey === who)
    .map((o) => ({ vout: o.vout, derivationPrefix: remittance.prefix, derivationSuffix: o.derivationSuffix }))
}

/** The same, from request entries an acceptor delivers for the sender. */
export function deliveryOutputsFromEntries(entries: ReadonlyArray<RecipientEntry>, recipient: string): DeliveryOutput[] {
  const who = recipient.toLowerCase()
  return entries.flatMap((e) =>
    e.identityKey === who && e.derivationPrefix && e.derivationSuffix
      ? [{ vout: e.vout, derivationPrefix: e.derivationPrefix, derivationSuffix: e.derivationSuffix }]
      : [],
  )
}
