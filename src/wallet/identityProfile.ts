import {
  Hash,
  MasterCertificate,
  PrivateKey,
  ProtoWallet,
  StorageUtils,
  Utils,
  VerifiableCertificate,
} from '@bsv/sdk'
import { base64ToBytes, bytesToBase64 } from './base64Binary'
import {
  IDENTITY_DESCRIPTION_MAX,
  IDENTITY_IMAGE_MAX_BYTES,
  IDENTITY_IMAGE_TYPES,
  IDENTITY_NAME_MAX,
  IDENTITY_PACKAGE_MAX_BYTES,
  issuerIdentityFields,
  issuerIdentityImage,
  type IssuerIdentityFields,
  type IssuerIdentityImage,
  type IssuerIdentityPackage,
} from './issuerIdentity'
import { normalizeIssuerIdentityKey } from './issuerMetadata'

/**
 * An identity key's own profile (BRC-248 §2, §3): a BRC-52 certificate whose
 * certifier and subject are both the identity key, with every field revealed
 * to anyone. It carries `name`, an optional `description`, a `profilePhoto`
 * UHRP URL and `issuedAt`; the image bytes travel beside it and must hash to
 * that URL. Nothing is on chain and nothing costs a fee: the identity key's
 * signature is the whole proof, so the profile is a claim by the issuer about
 * itself. Of two profiles by one key, the later `issuedAt` wins.
 */

export const IDENTITY_PROFILE_CERT_TYPE = Utils.toBase64(Hash.sha256(Utils.toArray('BRC-248 identity profile', 'utf8')))
const NULL_OUTPOINT = `${'00'.repeat(32)}.0`
const MAX_CERTIFICATES = 8
const MAX_IMAGES = 2
const FUTURE_SKEW_MS = 10 * 60 * 1000
const CONTROL = /[\u0000-\u001f\u007f]/
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const PHONE = /^\+?[\d\s().-]{7,}$/

/** A BRC-52 certificate as it travels: core fields plus the keyring that reveals them to anyone. */
export type ProfileCertificate = {
  type: string
  serialNumber: string
  subject: string
  certifier: string
  revocationOutpoint: string
  fields: Record<string, string>
  keyring: Record<string, string>
  signature: string
}

/** BRC-248 §3 image entry. */
export type PackageImage = { url: string; contentType: string; bytesB64: string }

/** A verified self-published profile. */
export type IdentityProfile = IssuerIdentityFields & {
  identityKey: string
  issuedAt: string
  image?: IssuerIdentityImage
}

/** What the store keeps and a package carries for one profile: the signed certificate and its image. */
export type IdentityProfileRecord = {
  certificate: ProfileCertificate
  image?: PackageImage
}

/** BRC-248 §1 package for one identity key. */
export type IdentityKeyPackage = {
  v: 2
  identityKey: string
  certificates?: ProfileCertificate[]
  images?: PackageImage[]
  bap?: { bapId: string; beefB64: string }
}

/** What `meta.identities` carries: v2 for an identity key, v1 for a BAP stamp an earlier draft wrote. */
export type DeliveredIdentityPackage = IssuerIdentityPackage | IdentityKeyPackage

function canonicalTime(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 32) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? value : null
}

function stringRecord(raw: unknown, max: number): Record<string, string> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const entries = Object.entries(raw as Record<string, unknown>)
  if (entries.length > max || entries.some(([, v]) => typeof v !== 'string')) return null
  return Object.fromEntries(entries) as Record<string, string>
}

export function parseProfileCertificate(raw: unknown): ProfileCertificate | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const row = raw as Record<string, unknown>
  const subject = normalizeIssuerIdentityKey(row.subject)
  const certifier = normalizeIssuerIdentityKey(row.certifier)
  const fields = stringRecord(row.fields, 16)
  const keyring = stringRecord(row.keyring, 16)
  if (
    typeof row.type !== 'string' ||
    typeof row.serialNumber !== 'string' ||
    typeof row.revocationOutpoint !== 'string' ||
    typeof row.signature !== 'string' ||
    !/^(?:[0-9a-f]{2}){8,80}$/.test(row.signature) ||
    !subject ||
    subject !== row.subject ||
    !certifier ||
    certifier !== row.certifier ||
    !fields ||
    !keyring
  )
    return null
  return {
    type: row.type,
    serialNumber: row.serialNumber,
    subject,
    certifier,
    revocationOutpoint: row.revocationOutpoint,
    fields,
    keyring,
    signature: row.signature,
  }
}

function parsePackageImage(raw: unknown): PackageImage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const row = raw as Record<string, unknown>
  if (typeof row.url !== 'string' || typeof row.contentType !== 'string' || typeof row.bytesB64 !== 'string') return null
  if (row.bytesB64.length > Math.ceil((IDENTITY_IMAGE_MAX_BYTES * 4) / 3) + 4) return null
  return { url: row.url, contentType: row.contentType, bytesB64: row.bytesB64 }
}

/** BRC-248 §3: the bytes must hash to the UHRP URL and be a small WebP, PNG or JPEG. */
export function packageImageBytes(image: PackageImage): IssuerIdentityImage | null {
  if (!(IDENTITY_IMAGE_TYPES as readonly string[]).includes(image.contentType)) return null
  try {
    if (!StorageUtils.isValidURL(image.url)) return null
    const bytes = base64ToBytes(image.bytesB64)
    if (bytes.length === 0 || bytes.length > IDENTITY_IMAGE_MAX_BYTES) return null
    const expected = StorageUtils.getHashFromURL(image.url)
    const actual = Hash.sha256(Array.from(bytes))
    if (expected.length !== actual.length || expected.some((byte, i) => byte !== actual[i])) return null
    return { contentType: image.contentType, bytes }
  } catch {
    return null
  }
}

export function parseIdentityKeyPackage(raw: unknown): IdentityKeyPackage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const identityKey = normalizeIssuerIdentityKey(value.identityKey)
  if (value.v !== 2 || !identityKey || identityKey !== value.identityKey) return null
  try {
    if (JSON.stringify(raw).length > IDENTITY_PACKAGE_MAX_BYTES) return null
  } catch {
    return null
  }
  const certificates = Array.isArray(value.certificates)
    ? value.certificates.slice(0, MAX_CERTIFICATES).flatMap((c) => parseProfileCertificate(c) ?? [])
    : []
  const images = Array.isArray(value.images)
    ? value.images.slice(0, MAX_IMAGES).flatMap((i) => parsePackageImage(i) ?? [])
    : []
  const rawBap = value.bap as { bapId?: unknown; beefB64?: unknown } | undefined
  const bap =
    rawBap && typeof rawBap.bapId === 'string' && typeof rawBap.beefB64 === 'string'
      ? { bapId: rawBap.bapId, beefB64: rawBap.beefB64 }
      : undefined
  return {
    v: 2,
    identityKey,
    ...(certificates.length ? { certificates } : {}),
    ...(images.length ? { images } : {}),
    ...(bap ? { bap } : {}),
  }
}

function displayName(value: string | undefined): string | null {
  if (typeof value !== 'string') return null
  if (!value || value !== value.trim() || value.length > IDENTITY_NAME_MAX || CONTROL.test(value)) return null
  if (EMAIL.test(value) || PHONE.test(value)) return null
  return value
}

/**
 * Verify a self-published profile certificate for `identityKey`: the
 * identity key certified it about itself, its signature holds, and its
 * revealed fields name a valid profile. The photo is whichever of `images`
 * the `profilePhoto` URL names; a named photo that is missing or does not
 * hash to its URL refuses the profile.
 */
export async function verifyIdentityProfile(
  identityKey: string,
  certificate: ProfileCertificate,
  images: readonly PackageImage[],
  opts?: { now?: number },
): Promise<{ record: IdentityProfileRecord; profile: IdentityProfile } | null> {
  const key = normalizeIssuerIdentityKey(identityKey)
  const cert = certificate
  if (!key || cert.type !== IDENTITY_PROFILE_CERT_TYPE || cert.subject !== key || cert.certifier !== key) return null
  let fields: Record<string, string>
  try {
    const verifiable = new VerifiableCertificate(
      cert.type,
      cert.serialNumber,
      cert.subject,
      cert.certifier,
      cert.revocationOutpoint,
      cert.fields,
      cert.keyring,
      cert.signature,
    )
    if (!(await verifiable.verify())) return null
    fields = await verifiable.decryptFields(new ProtoWallet('anyone'))
  } catch {
    return null
  }
  const name = displayName(fields.name)
  const issuedAt = canonicalTime(fields.issuedAt)
  const description = fields.description ?? ''
  if (!name || !issuedAt || description.length > IDENTITY_DESCRIPTION_MAX || CONTROL.test(description)) return null
  if (Date.parse(issuedAt) > (opts?.now ?? Date.now()) + FUTURE_SKEW_MS) return null
  const photo = fields.profilePhoto
  const entry = photo ? images.find((candidate) => candidate.url === photo) : undefined
  const image = entry ? packageImageBytes(entry) : null
  if (photo && !image) return null
  return {
    record: { certificate: cert, ...(entry && image ? { image: entry } : {}) },
    profile: { identityKey: key, name, description, issuedAt, ...(image ? { image } : {}) },
  }
}

/** The newest valid self-published profile a package carries for its identity key. */
export async function profileFromPackage(
  pkg: IdentityKeyPackage,
  opts?: { now?: number },
): Promise<{ record: IdentityProfileRecord; profile: IdentityProfile } | null> {
  let best: { record: IdentityProfileRecord; profile: IdentityProfile } | null = null
  for (const certificate of pkg.certificates ?? []) {
    if (certificate.type !== IDENTITY_PROFILE_CERT_TYPE || certificate.certifier !== pkg.identityKey) continue
    const verified = await verifyIdentityProfile(pkg.identityKey, certificate, pkg.images ?? [], opts)
    if (verified && (!best || verified.profile.issuedAt > best.profile.issuedAt)) best = verified
  }
  return best
}

/**
 * Sign this identity key's profile. The image is addressed by its SHA-256
 * (UHRP), so the certificate commits to the exact bytes it shows.
 */
export async function signIdentityProfile(args: {
  master: PrivateKey
  fields: IssuerIdentityFields
  image?: IssuerIdentityImage | null
  issuedAt: string
}): Promise<{ record: IdentityProfileRecord; profile: IdentityProfile }> {
  const { name, description } = issuerIdentityFields(args.fields)
  if (!displayName(name)) throw new Error('Use a name, not an email address or phone number.')
  const issuedAt = canonicalTime(args.issuedAt)
  if (!issuedAt) throw new Error('Profile time is not canonical.')
  const image = args.image ? issuerIdentityImage(args.image) : null
  const imageEntry: PackageImage | undefined = image
    ? {
        url: StorageUtils.getURLForFile(Array.from(image.bytes)),
        contentType: image.contentType,
        bytesB64: bytesToBase64(image.bytes),
      }
    : undefined
  const identityKey = args.master.toPublicKey().toString().toLowerCase()
  const wallet = new ProtoWallet(args.master)
  const plain: Record<string, string> = {
    name,
    issuedAt,
    ...(description ? { description } : {}),
    ...(imageEntry ? { profilePhoto: imageEntry.url } : {}),
  }
  const master = await MasterCertificate.issueCertificateForSubject(
    wallet,
    identityKey,
    plain,
    IDENTITY_PROFILE_CERT_TYPE,
    async () => NULL_OUTPOINT,
  )
  const keyring = await MasterCertificate.createKeyringForVerifier(
    wallet,
    identityKey,
    'anyone',
    master.fields,
    Object.keys(plain),
    master.masterKeyring,
    master.serialNumber,
  )
  const certificate: ProfileCertificate = {
    type: master.type,
    serialNumber: master.serialNumber,
    subject: master.subject.toLowerCase(),
    certifier: master.certifier.toLowerCase(),
    revocationOutpoint: master.revocationOutpoint,
    fields: { ...master.fields },
    keyring: { ...keyring },
    signature: master.signature!,
  }
  const verified = await verifyIdentityProfile(identityKey, certificate, imageEntry ? [imageEntry] : [])
  if (!verified) throw new Error('The signed profile did not verify.')
  return verified
}

/**
 * BRC-248 §1 package for `identityKey` from what this device holds, within
 * `budget` serialized bytes. The key's own profile is the label, so a linked
 * BAP profile is the first thing left out when both do not fit.
 */
export function identityKeyPackage(
  identityKey: string,
  parts: { profile?: IdentityProfileRecord | null; bap?: { bapId: string; beefB64: string } | null },
  budget = IDENTITY_PACKAGE_MAX_BYTES,
): IdentityKeyPackage | null {
  const key = normalizeIssuerIdentityKey(identityKey)
  if (!key) return null
  const build = (bap: typeof parts.bap): IdentityKeyPackage | null => {
    if (!parts.profile && !bap) return null
    const pkg: IdentityKeyPackage = {
      v: 2,
      identityKey: key,
      ...(parts.profile ? { certificates: [parts.profile.certificate] } : {}),
      ...(parts.profile?.image ? { images: [parts.profile.image] } : {}),
      ...(bap ? { bap } : {}),
    }
    return JSON.stringify(pkg).length <= Math.min(budget, IDENTITY_PACKAGE_MAX_BYTES) ? pkg : null
  }
  return build(parts.bap) ?? (parts.profile && parts.bap ? build(null) : null)
}
