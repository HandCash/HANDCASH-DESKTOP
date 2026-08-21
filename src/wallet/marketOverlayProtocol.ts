import {
  Hash,
  P2PKH,
  PrivateKey,
  PublicKey,
  PushDrop,
  Script,
  Signature,
  Utils,
} from '@bsv/sdk'

/** BRC-48 PushDrop field vocabulary for the HandCash 1Sat market overlay. */
export const MARKET_OFFER_MAGIC = '1SAT-MARKET'
export const MARKET_OFFER_VERSION = 1 as const
export const MARKET_ITEM_VOUT = 0 as const
export const MARKET_OFFER_VOUT = 1 as const
export const MARKET_OFFER_DEPOSIT_SATS = 1 as const
/**
 * Deterministic-JSON budget the overlay enforces on a published BRC-150 proof
 * (`MAX_PROVENANCE_BYTES` in BRC-CLOUD `marketProof.js`). Far larger than the
 * peer remittance wire budget, because a listing proof may not be slimmed.
 */
export const MARKET_MAX_PROVENANCE_JSON_BYTES = 1_000_000
/**
 * Txid-only path bodies the overlay will fetch for itself before refusing a
 * proof (`MAX_HYDRATED_PATH_TXS` in BRC-CLOUD `marketProof.js`).
 *
 * A proof within this budget is publishable as it stands, so the wallet does not
 * have to inline those bodies — which matters because a batch-mint origin is
 * megabytes and would overflow the JSON budget above anyway.
 */
export const MARKET_OVERLAY_HYDRATE_MAX_TXS = 8

export type MarketOfferFields = {
  magic: typeof MARKET_OFFER_MAGIC
  version: typeof MARKET_OFFER_VERSION
  itemVout: typeof MARKET_ITEM_VOUT
  sellerIdentityKey: string
  payTo: string
  grossPriceSats: number
  feeIdentityKey: string
  feePayTo: string
  feeBasisPoints: number
  exactFeeSats: number
  provenanceHash: string
  provenanceSize: number
  provenanceVersion: 2
  expiresAt: number | null
  nonce: string
  depositSats: typeof MARKET_OFFER_DEPOSIT_SATS
  messagebox: string
}

const SIGNED_FIELD_COUNT = 19
const FIELD_COUNT = 20
const OP_CHECKSIG = 0xac
const OP_2DROP = 0x6d
const utf8 = (value: string): number[] => Utils.toArray(value, 'utf8')
const text = (value: number[]): string =>
  new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(value))

function unsignedBytes(value: number, length: number): number[] {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid unsigned integer')
  let rest = BigInt(value)
  if (rest >= (1n << BigInt(length * 8))) throw new Error('Unsigned integer is out of range')
  const bytes = new Array<number>(length).fill(0)
  for (let index = length - 1; index >= 0; index -= 1) {
    bytes[index] = Number(rest & 0xffn)
    rest >>= 8n
  }
  return bytes
}

function readUnsigned(value: number[], length: number): number {
  if (value.length !== length) throw new Error('Invalid market offer integer width')
  let result = 0n
  for (const byte of value) result = (result << 8n) | BigInt(byte)
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Unsafe market offer integer')
  return Number(result)
}

function scriptCommitment(address: string): number[] {
  return Hash.sha256(new P2PKH().lock(address).toBinary())
}

function normalizeHex(value: string, bytes: number, field: string): string {
  const normalized = value.trim().toLowerCase()
  if (!new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(normalized)) {
    throw new Error(`Invalid ${field}`)
  }
  return normalized
}

export function normalizeMarketOfferFields(
  value: Omit<MarketOfferFields, 'magic' | 'version' | 'itemVout' | 'depositSats'> &
    Partial<Pick<MarketOfferFields, 'magic' | 'version' | 'itemVout' | 'depositSats'>>,
): MarketOfferFields {
  const sellerIdentityKey = PublicKey.fromString(
    value.sellerIdentityKey.trim().toLowerCase(),
  ).toString()
  const feeIdentityKey = PublicKey.fromString(
    value.feeIdentityKey.trim().toLowerCase(),
  ).toString()
  const payTo = value.payTo.trim()
  const feePayTo = value.feePayTo.trim()
  if (PublicKey.fromString(sellerIdentityKey).toAddress('mainnet') !== payTo) {
    throw new Error('Offer payTo does not match seller identity')
  }
  if (PublicKey.fromString(feeIdentityKey).toAddress('mainnet') !== feePayTo) {
    throw new Error('Offer fee address does not match fee identity')
  }
  const grossPriceSats = Number(value.grossPriceSats)
  const feeBasisPoints = Number(value.feeBasisPoints)
  const exactFeeSats = Number(value.exactFeeSats)
  const provenanceSize = Number(value.provenanceSize)
  const expiresAt = value.expiresAt == null ? null : Number(value.expiresAt)
  if (!Number.isSafeInteger(grossPriceSats) || grossPriceSats < 20) {
    throw new Error('Offer gross price must be at least 20 satoshis')
  }
  if (!Number.isSafeInteger(feeBasisPoints) || feeBasisPoints < 0 || feeBasisPoints > 10_000) {
    throw new Error('Invalid offer fee basis points')
  }
  if (
    !Number.isSafeInteger(exactFeeSats) ||
    exactFeeSats !== Math.floor((grossPriceSats * feeBasisPoints) / 10_000)
  ) {
    throw new Error('Offer exact fee does not match basis points')
  }
  if (!Number.isSafeInteger(provenanceSize) || provenanceSize < 1) {
    throw new Error('Invalid offer provenance size')
  }
  if (expiresAt != null && (!Number.isSafeInteger(expiresAt) || expiresAt < 1)) {
    throw new Error('Invalid offer expiry')
  }
  const messagebox = value.messagebox.trim()
  if (messagebox) {
    const parsed = new URL(messagebox)
    if (parsed.protocol !== 'https:') throw new Error('Offer messagebox must use HTTPS')
  }
  return {
    magic: MARKET_OFFER_MAGIC,
    version: MARKET_OFFER_VERSION,
    itemVout: MARKET_ITEM_VOUT,
    sellerIdentityKey,
    payTo,
    grossPriceSats,
    feeIdentityKey,
    feePayTo,
    feeBasisPoints,
    exactFeeSats,
    provenanceHash: normalizeHex(value.provenanceHash, 32, 'provenance hash'),
    provenanceSize,
    provenanceVersion: 2,
    expiresAt,
    nonce: normalizeHex(value.nonce, 16, 'offer nonce'),
    depositSats: MARKET_OFFER_DEPOSIT_SATS,
    messagebox,
  }
}

export function marketOfferFieldBytes(fields: MarketOfferFields): number[][] {
  const f = normalizeMarketOfferFields(fields)
  return [
    utf8(f.magic),
    unsignedBytes(f.version, 1),
    unsignedBytes(f.itemVout, 4),
    Utils.toArray(f.sellerIdentityKey, 'hex'),
    utf8(f.payTo),
    scriptCommitment(f.payTo),
    unsignedBytes(f.grossPriceSats, 8),
    Utils.toArray(f.feeIdentityKey, 'hex'),
    utf8(f.feePayTo),
    scriptCommitment(f.feePayTo),
    unsignedBytes(f.feeBasisPoints, 2),
    unsignedBytes(f.exactFeeSats, 8),
    Utils.toArray(f.provenanceHash, 'hex'),
    unsignedBytes(f.provenanceSize, 4),
    unsignedBytes(f.provenanceVersion, 1),
    unsignedBytes(f.expiresAt ?? 0, 8),
    Utils.toArray(f.nonce, 'hex'),
    unsignedBytes(f.depositSats, 8),
    utf8(f.messagebox),
  ]
}

/**
 * Final BRC-48 PushDrop wire format shared with tm_1sat_market.
 *
 * The seller signs the concatenated binary fields. The PushDrop lock itself is
 * seller-controlled, while the embedded signature lets an overlay validate the
 * advert without trusting its database projection.
 */
export function encodeMarketOffer(fields: MarketOfferFields, sellerKey: PrivateKey): string {
  const normalized = normalizeMarketOfferFields(fields)
  if (sellerKey.toPublicKey().toString() !== normalized.sellerIdentityKey) {
    throw new Error('Offer signing key does not match seller identity')
  }
  const offerFields = marketOfferFieldBytes(normalized)
  const encodedSignature = sellerKey.sign(offerFields.flat()).toDER()
  const signature =
    typeof encodedSignature === 'string'
      ? Utils.toArray(encodedSignature, 'hex')
      : encodedSignature
  const script = new Script()
  script.writeBin(Utils.toArray(normalized.sellerIdentityKey, 'hex'))
  script.writeOpCode(OP_CHECKSIG)
  for (const field of [...offerFields, signature]) script.writeBin(field)
  for (let i = 0; i < FIELD_COUNT / 2; i++) script.writeOpCode(OP_2DROP)
  return script.toHex()
}

export function parseMarketOffer(lockingScriptHex: string): MarketOfferFields {
  let decoded: ReturnType<typeof PushDrop.decode>
  try {
    decoded = PushDrop.decode(Script.fromHex(lockingScriptHex.trim().toLowerCase()), 'before')
  } catch {
    throw new Error('Invalid market offer PushDrop')
  }
  if (decoded.fields.length !== FIELD_COUNT) throw new Error('Invalid market offer field count')
  const raw = decoded.fields.map((field) => [...field])
  const expiresAt = readUnsigned(raw[15]!, 8)
  const parsed = normalizeMarketOfferFields({
    sellerIdentityKey: Utils.toHex(raw[3]!),
    payTo: text(raw[4]!),
    grossPriceSats: readUnsigned(raw[6]!, 8),
    feeIdentityKey: Utils.toHex(raw[7]!),
    feePayTo: text(raw[8]!),
    feeBasisPoints: readUnsigned(raw[10]!, 2),
    exactFeeSats: readUnsigned(raw[11]!, 8),
    provenanceHash: Utils.toHex(raw[12]!),
    provenanceSize: readUnsigned(raw[13]!, 4),
    provenanceVersion: readUnsigned(raw[14]!, 1) as 2,
    expiresAt: expiresAt === 0 ? null : expiresAt,
    nonce: Utils.toHex(raw[16]!),
    messagebox: text(raw[18]!),
  })
  if (
    text(raw[0]!) !== MARKET_OFFER_MAGIC ||
    readUnsigned(raw[1]!, 1) !== MARKET_OFFER_VERSION ||
    readUnsigned(raw[2]!, 4) !== MARKET_ITEM_VOUT ||
    readUnsigned(raw[17]!, 8) !== MARKET_OFFER_DEPOSIT_SATS ||
    readUnsigned(raw[14]!, 1) !== 2
  ) {
    throw new Error('Unsupported market offer protocol')
  }
  if (Utils.toHex(raw[5]!) !== Utils.toHex(scriptCommitment(parsed.payTo))) {
    throw new Error('Offer seller payout commitment mismatch')
  }
  if (Utils.toHex(raw[9]!) !== Utils.toHex(scriptCommitment(parsed.feePayTo))) {
    throw new Error('Offer fee payout commitment mismatch')
  }
  if (decoded.lockingPublicKey.toString().toLowerCase() !== parsed.sellerIdentityKey) {
    throw new Error('Offer seller control mismatch')
  }
  try {
    const signature = Signature.fromDER(raw[19]!)
    if (!decoded.lockingPublicKey.verify(raw.slice(0, SIGNED_FIELD_COUNT).flat(), signature)) {
      throw new Error('Invalid market offer signature')
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'Invalid market offer signature') throw error
    throw new Error('Invalid market offer signature')
  }
  return parsed
}
