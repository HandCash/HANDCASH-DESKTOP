import { Beef, PrivateKey, PublicKey, Transaction, Utils } from '@bsv/sdk'
import { base64ToBytes, bytesToBase64 } from './base64Binary'
import {
  BAP_REVOKED_ADDRESS,
  bapIdForAddress,
  bapKey,
  parseBapRecord,
  parseBFile,
  type BapRecord,
} from './bapRecords'
import { normalizeBapId } from './issuerMetadata'

/**
 * Issuer identity: a BAP identity whose ALIAS is a schema.org profile with a
 * B:// image. Nothing about it is a spendable output, so nothing about it can
 * be moved or sold; authority is the BAP key chain.
 *
 * An identity package is a BEEF of exactly the transactions a verifier needs:
 * the ID chain, the ALIAS and the image file, each with its merkle proof once
 * mined. It is stored once per BAP ID and travels beside BRC-150 remittance.
 */

export const IDENTITY_IMAGE_MAX_BYTES = 64 * 1024
export const IDENTITY_IMAGE_TYPES = ['image/webp', 'image/png', 'image/jpeg'] as const
export const IDENTITY_NAME_MAX = 80
export const IDENTITY_DESCRIPTION_MAX = 280
export const IDENTITY_PACKAGE_MAX_BYTES = 160 * 1024
const MAX_KEYS = 64

export type IssuerIdentityFields = { name: string; description: string }
export type IssuerIdentityImage = { contentType: string; bytes: Uint8Array }
export type BapSigningKey = { seq: number; address: string; txid: string; minedHeight?: number }

/** A verified identity: its key chain and the profile its active key signed. */
export type IssuerIdentity = IssuerIdentityFields & {
  bapId: string
  rootAddress: string
  /** Declared signing keys, `identity-1` first; the last one is current. */
  keys: BapSigningKey[]
  revoked?: { txid: string; minedHeight?: number }
  image?: IssuerIdentityImage
  /** B:// file transaction the profile names; reused by later profile updates. */
  imageTxid?: string
  alias: { txid: string; signer: string; minedHeight?: number }
}

export type IssuerIdentityPackage = { v: 1; bapId: string; beefB64: string }

/** Why a signer does or does not speak for an identity at a given height. */
export type SignerVerdict = 'active' | 'unknown-key' | 'retired-key' | 'revoked'

/**
 * What an asset's issuer stamp proves against the packages this wallet holds.
 * Only `verified` may show the identity's name or image; an `unconfirmed`
 * stamp can still be copied onto anyone's asset.
 */
export type IssuerAttribution =
  | { kind: 'verified'; identity: IssuerIdentity }
  | { kind: 'unconfirmed'; bapId: string; reason: 'no-package' | 'unknown-key' | 'height-unknown' }
  | { kind: 'refused'; bapId: string; reason: 'retired-key' | 'revoked' }

const CONTROL = /[\u0000-\u001f\u007f]/

export function issuerIdentityFields(fields: IssuerIdentityFields): IssuerIdentityFields {
  const name = fields.name.trim()
  const description = fields.description.trim()
  if (!name || name.length > IDENTITY_NAME_MAX)
    throw new Error(`Use a name of 1–${IDENTITY_NAME_MAX} characters.`)
  if (description.length > IDENTITY_DESCRIPTION_MAX)
    throw new Error(`Bio must be at most ${IDENTITY_DESCRIPTION_MAX} characters.`)
  if (CONTROL.test(name + description)) throw new Error('Name or bio contains control characters.')
  return { name, description }
}

export function issuerIdentityImage(image: IssuerIdentityImage): IssuerIdentityImage {
  if (!(IDENTITY_IMAGE_TYPES as readonly string[]).includes(image.contentType))
    throw new Error('Use a WebP, PNG or JPEG image.')
  if (image.bytes.length === 0 || image.bytes.length > IDENTITY_IMAGE_MAX_BYTES)
    throw new Error(`The image must be at most ${IDENTITY_IMAGE_MAX_BYTES / 1024} KB.`)
  return image
}

/** schema.org Person profile for a BAP ALIAS, as 1Sat / Yours wallets publish it. */
export function issuerProfile(fields: IssuerIdentityFields, imageTxid: string): Record<string, unknown> {
  const clean = issuerIdentityFields(fields)
  if (!/^[0-9a-f]{64}$/.test(imageTxid)) throw new Error('Invalid identity image reference.')
  return {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: clean.name,
    ...(clean.description ? { description: clean.description } : {}),
    image: `b://${imageTxid}`,
  }
}

export function parseIssuerIdentityPackage(raw: unknown): IssuerIdentityPackage | null {
  const value = raw as Partial<IssuerIdentityPackage> | null
  if (!value || typeof value !== 'object' || value.v !== 1) return null
  const bapId = normalizeBapId(value.bapId)
  if (!bapId || value.bapId !== bapId || typeof value.beefB64 !== 'string') return null
  if (value.beefB64.length > Math.ceil((IDENTITY_PACKAGE_MAX_BYTES * 4) / 3) + 4) return null
  return { v: 1, bapId, beefB64: value.beefB64 }
}

function isAddress(value: string): boolean {
  try {
    const decoded = Utils.fromBase58Check(value) as { data: number[] }
    return decoded.data.length === 20
  } catch {
    return false
  }
}

type Located<R extends BapRecord = BapRecord> = {
  txid: string
  order: number
  minedHeight?: number
  record: R
}
type IdRecord = Extract<BapRecord, { kind: 'id' }>
type AliasRecord = Extract<BapRecord, { kind: 'alias' }>

/** Earliest mined record wins; an unmined one only when it is the only claim. */
function firstOnChain<R extends BapRecord>(candidates: Located<R>[]): Located<R> | undefined {
  const mined = candidates
    .filter((c) => c.minedHeight !== undefined)
    .sort((a, b) => a.minedHeight! - b.minedHeight!)
  if (mined.length) return mined[1]?.minedHeight === mined[0]!.minedHeight ? undefined : mined[0]
  return candidates.length === 1 ? candidates[0] : undefined
}

function verdictAt(
  chain: Pick<IssuerIdentity, 'keys' | 'revoked'>,
  address: string,
  height?: number,
): SignerVerdict {
  const index = chain.keys.findIndex((key) => key.address === address)
  if (index < 0) return 'unknown-key'
  const revoked = chain.revoked
  if (revoked && (revoked.minedHeight === undefined || height === undefined || height >= revoked.minedHeight))
    return 'revoked'
  const successor = chain.keys[index + 1]
  if (!successor || successor.minedHeight === undefined) return 'active'
  return height !== undefined && height < successor.minedHeight ? 'active' : 'retired-key'
}

/**
 * Whether `signerKey` spoke for this identity in a block at `minedHeight`. A
 * retired key only counts for assets mined before its successor was mined, or
 * while that rotation is still unmined.
 */
export function issuerSignerVerdict(
  identity: IssuerIdentity,
  signerKey: string,
  minedHeight?: number,
): SignerVerdict {
  try {
    return verdictAt(identity, PublicKey.fromString(signerKey).toAddress(), minedHeight)
  } catch {
    return 'unknown-key'
  }
}

/** The identity's current signing key, derived from its master; refuses a chain it did not derive. */
export function currentIssuerSigningKey(master: PrivateKey, identity: Pick<IssuerIdentity, 'keys'>): PrivateKey {
  const current = identity.keys.at(-1)!
  const key = bapKey(master, current.seq)
  if (key.toAddress() !== current.address)
    throw new Error("This identity's key chain was not derived from this signing key.")
  return key
}

function imageFrom(
  value: unknown,
  beef: Beef,
): { image: IssuerIdentityImage; imageTxid?: string } | null {
  const ref =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object' && typeof (value as { contentUrl?: unknown }).contentUrl === 'string'
        ? (value as { contentUrl: string }).contentUrl
        : null
  if (!ref) return null
  try {
    const b = /^b:\/\/([0-9a-f]{64})$/i.exec(ref)
    if (b) {
      const imageTxid = b[1]!.toLowerCase()
      for (const output of beef.findTxid(imageTxid)?.tx?.outputs ?? []) {
        const file = parseBFile(output.lockingScript.toHex(), IDENTITY_IMAGE_MAX_BYTES)
        if (file) return { image: issuerIdentityImage(file), imageTxid }
      }
      return null
    }
    const data = /^data:([a-z/]+);base64,([A-Za-z0-9+/=]+)$/i.exec(ref)
    if (data && data[2]!.length <= Math.ceil((IDENTITY_IMAGE_MAX_BYTES * 4) / 3) + 4)
      return {
        image: issuerIdentityImage({ contentType: data[1]!.toLowerCase(), bytes: base64ToBytes(data[2]!) }),
      }
  } catch {
    /* unusable image: the profile still names the identity */
  }
  return null
}

function profileFrom(
  profile: Record<string, unknown>,
  beef: Beef,
): (IssuerIdentityFields & { image?: IssuerIdentityImage; imageTxid?: string }) | null {
  if (typeof profile.name !== 'string') return null
  let fields: IssuerIdentityFields
  try {
    fields = issuerIdentityFields({ name: profile.name, description: '' })
  } catch {
    return null
  }
  try {
    if (typeof profile.description === 'string')
      fields = issuerIdentityFields({ name: fields.name, description: profile.description })
  } catch {
    /* an oversized bio from another publisher is dropped, not fatal */
  }
  const image = imageFrom(profile.image, beef)
  return { ...fields, ...(image ?? {}) }
}

type Analysis = { identity: IssuerIdentity; txids: string[] }
type KeyChain = Pick<IssuerIdentity, 'rootAddress' | 'keys' | 'revoked'>

function recordsOf(beef: Beef, bapId: string): Located[] {
  const records: Located[] = []
  beef.txs.forEach((btx, order) => {
    if (!btx.tx) return
    const minedHeight =
      btx.bumpIndex === undefined ? undefined : beef.bumps[btx.bumpIndex]?.blockHeight
    for (const output of btx.tx.outputs) {
      const record = parseBapRecord(output.lockingScript.toHex())
      if (record?.bapId === bapId) records.push({ txid: btx.txid, order, minedHeight, record })
    }
  })
  return records
}

function keyChainOf(records: Located[], bapId: string): KeyChain | null {
  const ids = records.filter((r): r is Located<IdRecord> => r.record.kind === 'id')
  const rootAddress = ids.map((r) => r.record.signer).find((s) => bapIdForAddress(s) === bapId)
  if (!rootAddress) return null

  const keys: BapSigningKey[] = []
  const seen = new Set([rootAddress])
  let current = rootAddress
  while (keys.length < MAX_KEYS) {
    const next = firstOnChain(
      ids.filter(
        (r) =>
          r.record.signer === current &&
          r.record.address !== BAP_REVOKED_ADDRESS &&
          isAddress(r.record.address),
      ),
    )
    if (!next || seen.has(next.record.address)) break
    seen.add(next.record.address)
    keys.push({
      seq: keys.length + 1,
      address: next.record.address,
      txid: next.txid,
      ...(next.minedHeight !== undefined ? { minedHeight: next.minedHeight } : {}),
    })
    current = next.record.address
  }
  if (!keys.length) return null

  const revokes = ids.filter(
    (r) => r.record.signer === rootAddress && r.record.address === BAP_REVOKED_ADDRESS,
  )
  const revoke = firstOnChain(revokes) ?? revokes[0]
  const revoked = revoke
    ? { txid: revoke.txid, ...(revoke.minedHeight !== undefined ? { minedHeight: revoke.minedHeight } : {}) }
    : undefined
  return { rootAddress, keys, ...(revoked ? { revoked } : {}) }
}

/**
 * The key chain `beefs` establish for `bapId`, with or without a usable ALIAS:
 * a chain published elsewhere (or by the earlier BAP compose) must be continued,
 * never re-declared from the root.
 */
export function bapKeyChain(bapId: string, beefs: readonly number[][]): KeyChain | null {
  try {
    const work = new Beef()
    for (const binary of beefs) work.mergeBeef(binary)
    return keyChainOf(recordsOf(work, bapId), bapId)
  } catch {
    return null
  }
}

function analyze(beef: Beef, bapId: string, preferAlias?: string): Analysis | null {
  const records = recordsOf(beef, bapId)
  const chain = keyChainOf(records, bapId)
  if (!chain) return null
  const { rootAddress, keys, revoked } = chain
  // A revoked identity keeps its profile so holders see the revocation;
  // `issuerSignerVerdict` is what refuses attribution.
  const keyIndex = (address: string) => keys.findIndex((key) => key.address === address)
  const declaredWith = (alias: Located<AliasRecord>) =>
    records.some(
      (r) => r.txid === alias.txid && r.record.kind === 'id' && r.record.address === alias.record.signer,
    )
  const offset = (alias: Located<AliasRecord>) => {
    const btx = beef.findTxid(alias.txid)
    const bump = btx?.bumpIndex === undefined ? undefined : beef.bumps[btx.bumpIndex]
    return bump?.path[0]?.find((leaf) => leaf.hash === alias.txid)?.offset ?? 0
  }
  // Newest profile first, decided from the records alone: a later key's
  // profile supersedes an earlier key's; within a key, an unmined ALIAS is newer
  // than a mined one, a higher block newer than a lower, and the ALIAS written
  // beside the key's own declaration is that key's first profile.
  const aliases = records
    .filter((r): r is Located<AliasRecord> => r.record.kind === 'alias')
    .filter((r) => verdictAt({ keys }, r.record.signer, r.minedHeight) === 'active')
    .sort((a, b) => {
      if (preferAlias && (a.txid === preferAlias) !== (b.txid === preferAlias))
        return a.txid === preferAlias ? -1 : 1
      const byKey = keyIndex(b.record.signer) - keyIndex(a.record.signer)
      if (byKey) return byKey
      if ((a.minedHeight === undefined) !== (b.minedHeight === undefined))
        return a.minedHeight === undefined ? -1 : 1
      if (a.minedHeight !== b.minedHeight) return b.minedHeight! - a.minedHeight!
      if (declaredWith(a) !== declaredWith(b)) return declaredWith(a) ? 1 : -1
      return offset(b) - offset(a) || b.order - a.order
    })
  for (const alias of aliases) {
    const profile = profileFrom(alias.record.profile, beef)
    if (!profile) continue
    const identity: IssuerIdentity = {
      bapId,
      rootAddress,
      keys,
      ...(revoked ? { revoked } : {}),
      ...profile,
      alias: {
        txid: alias.txid,
        signer: alias.record.signer,
        ...(alias.minedHeight !== undefined ? { minedHeight: alias.minedHeight } : {}),
      },
    }
    const txids = new Set([...keys.map((key) => key.txid), alias.txid])
    if (revoked) txids.add(revoked.txid)
    if (profile.imageTxid) txids.add(profile.imageTxid)
    return { identity, txids: [...txids] }
  }
  return null
}

function readBeef(pkg: IssuerIdentityPackage): Beef | null {
  try {
    const bytes = base64ToBytes(pkg.beefB64)
    if (bytes.length > IDENTITY_PACKAGE_MAX_BYTES) return null
    const beef = Beef.fromBinary(Array.from(bytes))
    return beef.verifyValid(true).valid ? beef : null
  } catch {
    return null
  }
}

export function verifyIssuerIdentityPackage(raw: unknown): IssuerIdentity | null {
  const pkg = parseIssuerIdentityPackage(raw)
  const beef = pkg ? readBeef(pkg) : null
  return pkg && beef ? (analyze(beef, pkg.bapId)?.identity ?? null) : null
}

/** Merkle roots the package's proofs claim, for a header check before trusting heights. */
export function issuerIdentityPackageRoots(raw: unknown): Array<{ height: number; root: string }> | null {
  const pkg = parseIssuerIdentityPackage(raw)
  const beef = pkg ? readBeef(pkg) : null
  if (!beef) return null
  return Object.entries(beef.verifyValid(true).roots).map(([height, root]) => ({
    height: Number(height),
    root,
  }))
}

export function issuerIdentityPackageBeef(pkg: IssuerIdentityPackage): number[] {
  return Array.from(base64ToBytes(pkg.beefB64))
}

/**
 * The minimal package for `bapId` over every transaction in `beefs`: the chain,
 * the chosen ALIAS and its image. Mined transactions carry their proof; an
 * unmined one carries its parents as txid-only, since its AIP signature, not
 * its ancestry, is what makes it a claim by that key.
 */
export function buildIssuerIdentityPackage(
  bapId: string,
  beefs: readonly number[][],
  opts?: { preferAlias?: string },
): IssuerIdentityPackage | null {
  try {
    const work = new Beef()
    for (const binary of beefs) work.mergeBeef(binary)
    const analysis = analyze(work, bapId, opts?.preferAlias)
    if (!analysis || (opts?.preferAlias && analysis.identity.alias.txid !== opts.preferAlias)) return null
    const chosen = new Set(analysis.txids)
    const out = new Beef()
    for (const txid of analysis.txids) {
      const entry = work.findTxid(txid)
      if (!entry?.tx) return null
      const tx = Transaction.fromBinary(entry.tx.toBinary())
      const bump = entry.bumpIndex === undefined ? undefined : work.bumps[entry.bumpIndex]
      if (bump) tx.merklePath = bump
      out.mergeTransaction(tx)
      if (bump) continue
      for (const input of tx.inputs) {
        const parent = input.sourceTXID
        if (parent && !chosen.has(parent) && !out.findTxid(parent)) out.mergeTxidOnly(parent)
      }
    }
    out.sortTxs()
    const binary = out.toBinary()
    if (binary.length > IDENTITY_PACKAGE_MAX_BYTES) return null
    const pkg: IssuerIdentityPackage = { v: 1, bapId, beefB64: bytesToBase64(binary) }
    return verifyIssuerIdentityPackage(pkg)?.alias.txid === analysis.identity.alias.txid ? pkg : null
  } catch {
    return null
  }
}

const dataUrls = new WeakMap<IssuerIdentityImage, string>()
export function issuerIdentityImageDataUrl(image: IssuerIdentityImage): string {
  let url = dataUrls.get(image)
  if (!url) {
    url = `data:${image.contentType};base64,${bytesToBase64(image.bytes)}`
    dataUrls.set(image, url)
  }
  return url
}
