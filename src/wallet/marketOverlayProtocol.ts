import { P2PKH, PublicKey, Script, Utils } from '@bsv/sdk'

/** BRC-48 PushDrop field vocabulary for the HandCash 1Sat market overlay. */
export const MARKET_OFFER_MAGIC = '1SAT-MARKET-OFFER'
export const MARKET_OFFER_VERSION = 1 as const
export const MARKET_ITEM_VOUT = 0 as const
export const MARKET_OFFER_VOUT = 1 as const
export const MARKET_OFFER_DEPOSIT_SATS = 1 as const

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

const FIELD_COUNT = 17
const OP_DROP = 0x75
const utf8 = (value: string): number[] => Utils.toArray(value, 'utf8')
const text = (value: number[]): string =>
  new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(value))

function safeInteger(value: string, field: string, min = 0): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error(`Invalid ${field}`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min) {
    throw new Error(`Invalid ${field}`)
  }
  return parsed
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

export function marketOfferFieldStrings(fields: MarketOfferFields): string[] {
  const f = normalizeMarketOfferFields(fields)
  return [
    f.magic,
    String(f.version),
    String(f.itemVout),
    f.sellerIdentityKey,
    f.payTo,
    String(f.grossPriceSats),
    f.feeIdentityKey,
    f.feePayTo,
    String(f.feeBasisPoints),
    String(f.exactFeeSats),
    f.provenanceHash,
    String(f.provenanceSize),
    String(f.provenanceVersion),
    f.expiresAt == null ? '0' : String(f.expiresAt),
    f.nonce,
    String(f.depositSats),
    f.messagebox,
  ]
}

/**
 * Deterministic BRC-48 PushDrop: ordered UTF-8 fields, one OP_DROP per field,
 * followed by the seller P2PKH lock. Re-encoding is the canonicality check.
 */
export function encodeMarketOffer(fields: MarketOfferFields): string {
  const normalized = normalizeMarketOfferFields(fields)
  const script = new Script()
  for (const field of marketOfferFieldStrings(normalized)) script.writeBin(utf8(field))
  for (let i = 0; i < FIELD_COUNT; i++) script.writeOpCode(OP_DROP)
  script.writeScript(new P2PKH().lock(normalized.payTo))
  return script.toHex()
}

export function parseMarketOffer(lockingScriptHex: string): MarketOfferFields {
  const hex = lockingScriptHex.trim().toLowerCase()
  const script = Script.fromHex(hex)
  const chunks = script.chunks
  if (chunks.length !== FIELD_COUNT * 2 + 5) throw new Error('Invalid market offer shape')
  const raw = chunks.slice(0, FIELD_COUNT).map((chunk) => {
    if (!chunk.data) throw new Error('Market offer field is not pushed data')
    return text(chunk.data)
  })
  if (chunks.slice(FIELD_COUNT, FIELD_COUNT * 2).some((chunk) => chunk.op !== OP_DROP)) {
    throw new Error('Market offer has invalid PushDrop cleanup')
  }
  const expiresAt = safeInteger(raw[13]!, 'offer expiry')
  const parsed = normalizeMarketOfferFields({
    sellerIdentityKey: raw[3]!,
    payTo: raw[4]!,
    grossPriceSats: safeInteger(raw[5]!, 'gross price', 20),
    feeIdentityKey: raw[6]!,
    feePayTo: raw[7]!,
    feeBasisPoints: safeInteger(raw[8]!, 'fee basis points'),
    exactFeeSats: safeInteger(raw[9]!, 'exact fee'),
    provenanceHash: raw[10]!,
    provenanceSize: safeInteger(raw[11]!, 'provenance size', 1),
    provenanceVersion: safeInteger(raw[12]!, 'provenance version') as 2,
    expiresAt: expiresAt === 0 ? null : expiresAt,
    nonce: raw[14]!,
    messagebox: raw[16]!,
  })
  if (
    raw[0] !== MARKET_OFFER_MAGIC ||
    safeInteger(raw[1]!, 'offer version') !== MARKET_OFFER_VERSION ||
    safeInteger(raw[2]!, 'item vout') !== MARKET_ITEM_VOUT ||
    safeInteger(raw[15]!, 'offer deposit') !== MARKET_OFFER_DEPOSIT_SATS ||
    raw[12] !== '2'
  ) {
    throw new Error('Unsupported market offer protocol')
  }
  if (encodeMarketOffer(parsed) !== hex) throw new Error('Non-canonical market offer')
  return parsed
}
