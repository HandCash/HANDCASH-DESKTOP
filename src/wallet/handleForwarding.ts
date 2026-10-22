/**
 * BRC-169 §4.3 forwarding records. The departing subject signs where it went;
 * the host only stores the record, so it cannot fabricate a redirect. A client
 * checks the record against the key it already pinned for the old handle and
 * never follows it on its own.
 */
import { PrivateKey, PublicKey, Signature, Utils } from '@bsv/sdk'

export const FORWARDING_PROTOCOL: [2, string] = [2, 'metanet handles envelope']
export const FORWARDING_KEY_ID = 'forward'
const FORWARDING_INVOICE = `${FORWARDING_PROTOCOL[0]}-${FORWARDING_PROTOCOL[1]}-${FORWARDING_KEY_ID}`

export type ForwardingRecord = {
  from: string
  toIdentityKey: string
  toHandle: string
  created: string
  signature: string
}

const IDENTITY_KEY = /^(02|03)[0-9a-f]{64}$/
const QUALIFIED_HANDLE = /^@[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?@[a-z0-9.-]+\.[a-z]{2,}$/
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
const DER_HEX = /^30[0-9a-f]{12,140}$/

export function forwardingPreimage(record: Omit<ForwardingRecord, 'signature'>): string {
  return `${record.from}\n${record.toIdentityKey}\n${record.toHandle}\n${record.created}\n`
}

export function parseForwardingRecord(raw: unknown): ForwardingRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const record = {
    from: text(row.from).toLowerCase(),
    toIdentityKey: text(row.toIdentityKey).toLowerCase(),
    toHandle: text(row.toHandle).toLowerCase(),
    created: text(row.created),
    signature: text(row.signature).toLowerCase(),
  }
  if (!QUALIFIED_HANDLE.test(record.from) || !QUALIFIED_HANDLE.test(record.toHandle)) return null
  if (record.from === record.toHandle || !IDENTITY_KEY.test(record.toIdentityKey)) return null
  if (!ISO_UTC.test(record.created) || Number.isNaN(Date.parse(record.created))) return null
  return DER_HEX.test(record.signature) ? record : null
}

export function signForwardingRecord(
  rootKeyHex: string,
  target: { from: string; toIdentityKey: string; toHandle: string; created?: string },
): ForwardingRecord {
  const unsigned = {
    from: target.from.trim().toLowerCase(),
    toIdentityKey: target.toIdentityKey.trim().toLowerCase(),
    toHandle: target.toHandle.trim().toLowerCase(),
    created: target.created ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  }
  const signer = PrivateKey.fromHex(rootKeyHex.trim()).deriveChild(
    new PrivateKey(1).toPublicKey(),
    FORWARDING_INVOICE,
  )
  const signature = signer.sign(Utils.toArray(forwardingPreimage(unsigned), 'utf8')).toDER('hex') as string
  const record = parseForwardingRecord({ ...unsigned, signature })
  if (!record) throw new Error('Forwarding target is not a fully-qualified handle and identity key')
  return record
}

/** The record, when `previousIdentityKey` (the released handle's subject) signed it. */
export function verifiedForwarding(raw: unknown, previousIdentityKey: string): ForwardingRecord | null {
  const record = parseForwardingRecord(raw)
  const subject = previousIdentityKey.trim().toLowerCase()
  if (!record || !IDENTITY_KEY.test(subject)) return null
  try {
    const signer = PublicKey.fromString(subject).deriveChild(new PrivateKey(1), FORWARDING_INVOICE)
    const signature = Signature.fromDER(Utils.toArray(record.signature, 'hex'))
    return signer.verify(Utils.toArray(forwardingPreimage(record), 'utf8'), signature) ? record : null
  } catch {
    return null
  }
}
