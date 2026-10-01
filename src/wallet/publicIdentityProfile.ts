import { PrivateKey, PublicKey, Signature, Utils } from '@bsv/sdk'
import type { Chain } from './vault'

/** Public attribution only: neither possession nor this signature grants spend authority. */
export type PublicIdentityProfile = {
  kind: 'handcash-public-identity'
  version: 1
  identityKey: string
  chain: Chain
  displayName: string
  icon: string
  description: string
  updatedAt: number
  signature: string
}
export type PublicIdentityFields = Pick<
  PublicIdentityProfile,
  'displayName' | 'icon' | 'description'
>
const DOMAIN = 'HandCash-public-identity-v1\n'

export function normalizePublicIdentityKey(value: unknown): string | null {
  if (typeof value !== 'string' || !/^(02|03)[0-9a-f]{64}$/i.test(value.trim()))
    return null
  try {
    return PublicKey.fromString(value.trim()).toString().toLowerCase()
  } catch {
    return null
  }
}

export function publicIdentityFields(
  fields: PublicIdentityFields,
): PublicIdentityFields {
  const displayName = fields.displayName.trim()
  const icon = fields.icon.trim()
  const description = fields.description.trim()
  if (!displayName || displayName.length > 80)
    throw new Error('Use a display name of 1–80 characters.')
  if (description.length > 280)
    throw new Error('About must be at most 280 characters.')
  if (icon.length > 512) throw new Error('Icon URL is too long.')
  let validIcon = /^ord:\/\/[0-9a-f]{64}[_.][0-9]+$/i.test(icon)
  try {
    const url = new URL(icon)
    validIcon ||= url.protocol === 'https:' && !url.username && !url.password
  } catch {
    /* checked below */
  }
  if (!validIcon) throw new Error('Add an HTTPS or ord:// icon URL.')
  if (/[\u0000-\u001f\u007f]/.test(displayName + description + icon))
    throw new Error('Profile contains control characters.')
  return { displayName, icon, description }
}

function preimage(profile: Omit<PublicIdentityProfile, 'signature'>): number[] {
  return Utils.toArray(
    DOMAIN +
      JSON.stringify({
        kind: profile.kind,
        version: profile.version,
        identityKey: profile.identityKey,
        chain: profile.chain,
        displayName: profile.displayName,
        icon: profile.icon,
        description: profile.description,
        updatedAt: profile.updatedAt,
      }),
    'utf8',
  )
}

export function signPublicIdentityProfile(
  rootKeyHex: string,
  chain: Chain,
  fields: PublicIdentityFields,
): PublicIdentityProfile {
  const key = PrivateKey.fromHex(rootKeyHex)
  const body = {
    kind: 'handcash-public-identity' as const,
    version: 1 as const,
    identityKey: key.toPublicKey().toString().toLowerCase(),
    chain,
    ...publicIdentityFields(fields),
    updatedAt: Date.now(),
  }
  return { ...body, signature: String(key.sign(preimage(body)).toDER('hex')) }
}

/**
 * Every held asset can carry its issuer's profile, and Collect groups on each
 * render, so the same signature arrives many times. The verdict is keyed by
 * the exact signed bytes and signature.
 */
const MAX_VERDICTS = 512
const verdicts = new Map<string, boolean>()

function signatureValid(identityKey: string, message: number[], signature: string): boolean {
  const key = `${identityKey}:${signature.toLowerCase()}:${Utils.toHex(message)}`
  const known = verdicts.get(key)
  if (known !== undefined) return known
  const valid = PublicKey.fromString(identityKey).verify(message, Signature.fromDER(signature, 'hex'))
  verdicts.set(key, valid)
  if (verdicts.size > MAX_VERDICTS) verdicts.delete(verdicts.keys().next().value!)
  return valid
}

/** Fail closed on malformed, tampered, wrong-key, or wrong-network profiles. */
export function verifyPublicIdentityProfile(
  raw: unknown,
  expectedKey?: string,
  chain?: Chain,
): PublicIdentityProfile | null {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const profile = raw as PublicIdentityProfile
    const keys = [
      'kind',
      'version',
      'identityKey',
      'chain',
      'displayName',
      'icon',
      'description',
      'updatedAt',
      'signature',
    ]
    if (
      Object.keys(profile).length !== keys.length ||
      keys.some((key) => !(key in profile))
    )
      return null
    if (profile.kind !== 'handcash-public-identity' || profile.version !== 1)
      return null
    const identityKey = normalizePublicIdentityKey(profile.identityKey)
    if (
      !identityKey ||
      identityKey !== profile.identityKey ||
      (expectedKey && identityKey !== normalizePublicIdentityKey(expectedKey))
    )
      return null
    if (
      !['main', 'test'].includes(profile.chain) ||
      (chain && chain !== profile.chain)
    )
      return null
    if (
      !Number.isSafeInteger(profile.updatedAt) ||
      profile.updatedAt <= 0 ||
      profile.updatedAt > Date.now() + 60_000
    )
      return null
    if (
      typeof profile.displayName !== 'string' ||
      typeof profile.icon !== 'string' ||
      typeof profile.description !== 'string'
    )
      return null
    const fields = publicIdentityFields(profile)
    if (
      fields.displayName !== profile.displayName ||
      fields.icon !== profile.icon ||
      fields.description !== profile.description
    )
      return null
    if (
      typeof profile.signature !== 'string' ||
      !/^[0-9a-f]{128,144}$/i.test(profile.signature)
    )
      return null
    if (!signatureValid(identityKey, preimage(profile), profile.signature))
      return null
    return { ...profile }
  } catch {
    return null
  }
}

export function profileFromRemittance(
  raw?: string,
): PublicIdentityProfile | null {
  if (!raw || raw.length > 64 * 1024) return null
  try {
    const record = JSON.parse(raw)
    const issuer = normalizePublicIdentityKey(record.issuer)
    return issuer
      ? verifyPublicIdentityProfile(record.issuerProfile, issuer)
      : null
  } catch {
    return null
  }
}
