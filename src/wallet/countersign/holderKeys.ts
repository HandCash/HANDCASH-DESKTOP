import { Hash, KeyDeriver, PrivateKey, ProtoWallet, PublicKey, Utils } from '@bsv/sdk'
import {
  COLOR_KEY_ID,
  colorPrivateKey,
  colorProtocol,
  colorPublicKey,
  freshRemittanceString,
  readColorRemittance,
  type ColorRemittance,
} from '../colorKeys'

/**
 * BRC-253 holder keys: every countersigned output is held under a BRC-207
 * `p color` child, never an identity key. A transfer draws one prefix and a
 * suffix per output; the acceptor learns who is behind each output from a
 * BRC-69 specific linkage encrypted to it (BRC-72), and the recipient derives
 * its key from the delivery's remittance.
 */

/** One output of a transfer: who holds it and its suffix under the transfer's prefix. */
export type HolderOutput = { vout: number; identityKey: string; derivationSuffix: string }

/** The remittance a sender keeps for one transfer, enough to rebuild every request and delivery. */
export type HolderRemittance = { prefix: string; outputs: HolderOutput[] }

/** One `recipients` entry of a request. Entries without linkage name an identity-key holder. */
export type RecipientEntry = {
  vout: number
  identityKey: string
  derivationPrefix?: string
  derivationSuffix?: string
  encryptedLinkage?: string
  encryptedLinkageProof?: string
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

/** The asset a holder key derives under: a deploy output keeps `ISSUE` after its id is fixed. */
export function holderKeyAsset(assetId: string, outpoint: string): string {
  return underscore(outpoint) === underscore(assetId) ? 'ISSUE' : assetId
}

/** A fresh transfer remittance: one prefix, one suffix per output. */
export function planHolderRemittance(outputs: ReadonlyArray<{ vout: number; identityKey: string }>): HolderRemittance {
  return {
    prefix: freshRemittanceString(),
    outputs: outputs.map((o) => ({
      vout: o.vout,
      identityKey: o.identityKey.toLowerCase(),
      derivationSuffix: freshRemittanceString(),
    })),
  }
}

/** The holder pubkey hash of one output: the named identity's `p color` child. */
export function holderPkhFor(root: PrivateKey, assetId: string, prefix: string, output: HolderOutput): string {
  return hash160Hex(colorPublicKey(root, assetId, prefix, output.derivationSuffix, output.identityKey))
}

/** The private key of an output this wallet holds under `remittance`. */
export function holderPrivateKey(root: PrivateKey, assetId: string, remittance: ColorRemittance): PrivateKey {
  return colorPrivateKey(root, assetId, remittance)
}

/** The remittance recorded on one held output (`customInstructions`), or null for an identity-key holding. */
export function holderRemittanceOf(customInstructions: unknown): ColorRemittance | null {
  let parsed: unknown = customInstructions
  if (typeof customInstructions === 'string') {
    try {
      parsed = JSON.parse(customInstructions)
    } catch {
      return null
    }
  }
  return readColorRemittance(parsed)
}

/** A request's `recipients` entry for one output, with its linkage encrypted to `verifier`. */
export async function recipientEntry(
  root: PrivateKey,
  assetId: string,
  prefix: string,
  output: HolderOutput,
  verifier: string,
): Promise<RecipientEntry> {
  const revealed = await new ProtoWallet(root).revealSpecificKeyLinkage({
    counterparty: output.identityKey,
    verifier,
    protocolID: colorProtocol(assetId, prefix, output.derivationSuffix),
    keyID: COLOR_KEY_ID,
  })
  return {
    vout: output.vout,
    identityKey: output.identityKey,
    derivationPrefix: prefix,
    derivationSuffix: output.derivationSuffix,
    encryptedLinkage: Utils.toBase64(revealed.encryptedLinkage),
    encryptedLinkageProof: Utils.toBase64(revealed.encryptedLinkageProof),
  }
}

/** Every entry of a request for `verifier`. */
export function recipientEntries(
  root: PrivateKey,
  assetId: string,
  remittance: HolderRemittance,
  verifier: string,
): Promise<RecipientEntry[]> {
  return Promise.all(remittance.outputs.map((o) => recipientEntry(root, assetId, remittance.prefix, o, verifier)))
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
          }
        : {}),
    })
  }
  return out
}

/**
 * The holder pubkey hash an entry proves, as the acceptor sees it: decrypt
 * the linkage the prover sent and take `identityKey + linkage·G`. An entry
 * without linkage names an identity-key holder (the earlier revision). Null
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
    const [, protocolName] = colorProtocol(assetId, entry.derivationPrefix, entry.derivationSuffix)
    const key = new KeyDeriver(acceptorRoot).deriveSymmetricKey(
      [2, `specific linkage revelation 2 ${protocolName}`],
      COLOR_KEY_ID,
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