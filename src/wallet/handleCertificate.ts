/**
 * BRC-169 §4.1 handle-certificate verification.
 *
 * The certifier for a domain must equal `metanet.trust.publicKey` in that
 * domain's manifest (§5.1). The wallet pins it instead of fetching the
 * manifest from the same host that answers resolve: a resolver that could
 * swap the manifest could swap the key too.
 *
 * Revocation: certificates carry the null outpoint until the certifier funds
 * revocation UTXOs; the resolver's 404/410 is the revocation channel (§5.3).
 */
import { Certificate, Utils } from '@bsv/sdk'

/** BRC-169 §4.5 handle-certificate type. */
export const BRC169_HANDLE_CERT_TYPE = 'XgCFdUfxEcI+3xtDjsIuSAjMl5EwzCUjsQc45ds1lC8='

export const HANDLE_CERTIFIERS: Readonly<Record<string, string>> = {
  'handcash.io': '027bf8f661e41618907329e78a0460ffe4a9b3c59dbc9fda49ccb4e08317b7de55',
}

export type HandleCertificate = {
  type: string
  serialNumber: string
  subject: string
  certifier: string
  revocationOutpoint: string
  fields: Record<string, string>
  signature: string
}

export type HandleCertificateRefusal =
  | 'missing'
  | 'placeholder'
  | 'malformed'
  | 'wrong-type'
  | 'unknown-domain'
  | 'wrong-certifier'
  | 'subject-mismatch'
  | 'field-mismatch'
  | 'bad-signature'

export type HandleCertificateVerdict =
  | { kind: 'verified'; certificate: HandleCertificate }
  | { kind: 'refused'; reason: HandleCertificateRefusal }

export type HandleBinding = { handle: string; domain: string; identityKey: string }

export class HandleCertificateError extends Error {
  readonly reason: HandleCertificateRefusal
  constructor(display: string, reason: HandleCertificateRefusal) {
    super(`Handle ${display} has no valid certificate (${reason})`)
    this.name = 'HandleCertificateError'
    this.reason = reason
  }
}

const COMPRESSED_KEY = /^(02|03)[0-9a-f]{64}$/

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

/** UTF-8 of a canonical Base64 field value, or null. */
export function handleCertificateField(value: unknown): string | null {
  const b64 = str(value)
  if (!b64) return null
  try {
    const bytes = Utils.toArray(b64, 'base64')
    if (Utils.toBase64(bytes) !== b64) return null
    return Utils.toUTF8(bytes)
  } catch {
    return null
  }
}

/** Plain shape of a certificate, or null when any element is missing. */
export function asHandleCertificate(raw: unknown): HandleCertificate | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  const fields = row.fields
  if (!fields || typeof fields !== 'object') return null
  const plainFields: Record<string, string> = {}
  for (const [name, value] of Object.entries(fields as Record<string, unknown>)) {
    if (typeof value !== 'string') return null
    plainFields[name] = value
  }
  const type = str(row.type)
  const serialNumber = str(row.serialNumber)
  const subject = str(row.subject)?.toLowerCase() ?? null
  const certifier = str(row.certifier)?.toLowerCase() ?? null
  const revocationOutpoint = str(row.revocationOutpoint)
  const signature = str(row.signature)
  if (!type || !serialNumber || !subject || !certifier || !revocationOutpoint || !signature) {
    return null
  }
  return { type, serialNumber, subject, certifier, revocationOutpoint, fields: plainFields, signature }
}

export async function verifyHandleCertificate(
  raw: unknown,
  binding: HandleBinding,
  certifiers: Readonly<Record<string, string>> = HANDLE_CERTIFIERS,
): Promise<HandleCertificateVerdict> {
  if (raw == null) return { kind: 'refused', reason: 'missing' }
  const row = raw as Record<string, unknown>
  if (
    row._dev === true ||
    (typeof row.signature === 'string' && row.signature.startsWith('dev-placeholder'))
  ) {
    return { kind: 'refused', reason: 'placeholder' }
  }
  const cert = asHandleCertificate(raw)
  if (!cert || !COMPRESSED_KEY.test(cert.subject) || !COMPRESSED_KEY.test(cert.certifier)) {
    return { kind: 'refused', reason: 'malformed' }
  }
  if (cert.type !== BRC169_HANDLE_CERT_TYPE) return { kind: 'refused', reason: 'wrong-type' }
  const domain = binding.domain.toLowerCase()
  const pinned = certifiers[domain]
  if (!pinned) return { kind: 'refused', reason: 'unknown-domain' }
  if (cert.certifier !== pinned) return { kind: 'refused', reason: 'wrong-certifier' }
  if (cert.subject !== binding.identityKey.toLowerCase()) {
    return { kind: 'refused', reason: 'subject-mismatch' }
  }
  if (
    handleCertificateField(cert.fields.handle) !== binding.handle.toLowerCase() ||
    handleCertificateField(cert.fields.domain) !== domain
  ) {
    return { kind: 'refused', reason: 'field-mismatch' }
  }
  if (!(await Certificate.fromObject(cert).verify())) {
    return { kind: 'refused', reason: 'bad-signature' }
  }
  return { kind: 'verified', certificate: cert }
}
