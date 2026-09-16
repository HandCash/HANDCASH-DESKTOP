/**
 * BRC-169 §7 envelopes for BRC-33 `body` strings.
 *
 * Metadata (who, when) is readable by the messagebox operator. `content` is
 * BRC-78 ciphertext; the operator must not be able to read chat, remittance,
 * or market-settlement cards. Envelope `payment` stays null — value facts ride
 * inside encrypted content (tolls / visible envelope payments are deferred).
 *
 * Legacy inbound `handcash-message:` / `handcash-session-offer:` plaintext is
 * still accepted so older threads keep working. Outbound is always sealed.
 */
import {
  EncryptedMessage,
  Hash,
  PrivateKey,
  PublicKey,
  Signature,
  Utils,
} from '@bsv/sdk'

export const PEER_ENVELOPE_VERSION = '1.0'

type EnvelopeParty = {
  identityKey: string
}

export type PeerEnvelopeWire = {
  metanetHandles: typeof PEER_ENVELOPE_VERSION
  recipient: EnvelopeParty
  sender: EnvelopeParty
  created: string
  payment: null
  content: string
  signature: string
}

const IDENTITY_KEY = /^[0-9a-f]{66}$/i

function normalizeIdentityKey(raw: string): string {
  const key = raw.trim().toLowerCase()
  if (!IDENTITY_KEY.test(key)) throw new Error('Invalid identity key')
  return key
}

/** RFC 8785 JSON Canonicalization Scheme for JSON-compatible values we emit. */
export function canonicalizeJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Cannot canonicalize non-finite number')
    return JSON.stringify(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort()
    return `{${keys
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalizeJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`
  }
  throw new Error('Cannot canonicalize value')
}

function envelopePreimage(meta: Omit<PeerEnvelopeWire, 'content' | 'signature'>): string {
  return canonicalizeJson(meta)
}

function signPreimage(root: PrivateKey, preimage: string): string {
  const sig = root.sign(Utils.toArray(preimage, 'utf8'))
  return String(sig.toDER('hex'))
}

function verifyPreimage(
  identityKey: string,
  preimage: string,
  derHex: string,
): boolean {
  try {
    const sig = Signature.fromDER(derHex, 'hex')
    return PublicKey.fromString(identityKey).verify(
      Utils.toArray(preimage, 'utf8'),
      sig,
    )
  } catch {
    return false
  }
}

export function looksLikePeerEnvelope(body: string): boolean {
  const text = body.trim()
  if (!text.startsWith('{')) return false
  try {
    const parsed = JSON.parse(text) as Partial<PeerEnvelopeWire>
    return (
      parsed?.metanetHandles === PEER_ENVELOPE_VERSION &&
      typeof parsed.content === 'string' &&
      typeof parsed.signature === 'string' &&
      typeof parsed.sender?.identityKey === 'string' &&
      typeof parsed.recipient?.identityKey === 'string'
    )
  } catch {
    return false
  }
}

export function sealPeerMessage(args: {
  plaintext: string
  rootKeyHex: string
  recipientIdentityKey: string
  created?: string
}): string {
  const sender = PrivateKey.fromHex(args.rootKeyHex.trim())
  const senderKey = normalizeIdentityKey(sender.toPublicKey().toString())
  const recipientKey = normalizeIdentityKey(args.recipientIdentityKey)
  const recipient = PublicKey.fromString(recipientKey)
  const cipher = EncryptedMessage.encrypt(
    Utils.toArray(args.plaintext, 'utf8'),
    sender,
    recipient,
  )
  const meta: Omit<PeerEnvelopeWire, 'content' | 'signature'> = {
    metanetHandles: PEER_ENVELOPE_VERSION,
    recipient: { identityKey: recipientKey },
    sender: { identityKey: senderKey },
    created: args.created ?? new Date().toISOString(),
    payment: null,
  }
  const envelope: PeerEnvelopeWire = {
    ...meta,
    content: Utils.toBase64(cipher),
    signature: signPreimage(sender, envelopePreimage(meta)),
  }
  return JSON.stringify(envelope)
}

export type OpenPeerMessage =
  | { plaintext: string; sealed: boolean }
  | { refuse: 'invalid-envelope' }

export function openPeerMessage(args: {
  body: string
  rootKeyHex: string
  expectedSenderIdentityKey?: string
}): OpenPeerMessage {
  const raw = args.body
  if (!looksLikePeerEnvelope(raw)) {
    return { plaintext: raw, sealed: false }
  }
  try {
    const envelope = JSON.parse(raw.trim()) as PeerEnvelopeWire
    const recipientKey = normalizeIdentityKey(envelope.recipient.identityKey)
    const senderKey = normalizeIdentityKey(envelope.sender.identityKey)
    if (
      args.expectedSenderIdentityKey &&
      senderKey !== normalizeIdentityKey(args.expectedSenderIdentityKey)
    ) {
      return { refuse: 'invalid-envelope' }
    }
    const recipient = PrivateKey.fromHex(args.rootKeyHex.trim())
    const self = normalizeIdentityKey(recipient.toPublicKey().toString())
    if (recipientKey !== self) return { refuse: 'invalid-envelope' }
    const meta: Omit<PeerEnvelopeWire, 'content' | 'signature'> = {
      metanetHandles: PEER_ENVELOPE_VERSION,
      recipient: { identityKey: recipientKey },
      sender: { identityKey: senderKey },
      created: envelope.created,
      payment: envelope.payment ?? null,
    }
    if (
      typeof envelope.created !== 'string' ||
      envelope.payment !== null ||
      !verifyPreimage(senderKey, envelopePreimage(meta), envelope.signature)
    ) {
      return { refuse: 'invalid-envelope' }
    }
    const plain = EncryptedMessage.decrypt(
      Utils.toArray(envelope.content, 'base64'),
      recipient,
    )
    return { plaintext: Utils.toUTF8(plain), sealed: true }
  } catch {
    return { refuse: 'invalid-envelope' }
  }
}

/** Digest used only in tests to show the operator cannot recover plaintext. */
export function envelopeContentDigest(body: string): string | null {
  if (!looksLikePeerEnvelope(body)) return null
  try {
    const envelope = JSON.parse(body.trim()) as PeerEnvelopeWire
    return Utils.toHex(Hash.sha256(Utils.toArray(envelope.content, 'utf8')))
  } catch {
    return null
  }
}
