import {
  Hash,
  KeyDeriver,
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
/** Version 2 (BRC-254 v2): BRC-29 listing key, BRC-3 signature. Version 1 is read only. */
export const MARKET_OFFER_VERSION = 2 as const
export type MarketOfferVersion = 1 | typeof MARKET_OFFER_VERSION
/** BRC-3 signature of a v2 offer: the seller's child for this protocol, counterparty `anyone`. */
export const MARKET_OFFER_SIGNATURE_PROTOCOL: [2, string] = [2, '1sat market offer']
export const MARKET_OFFER_SIGNATURE_KEY_ID = '1'
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
  version: MarketOfferVersion
  itemVout: typeof MARKET_ITEM_VOUT
  sellerIdentityKey: string
  /**
   * v2: the seller's BRC-29 child that locks the offer token and (for `1sat` /
   * `p2pft`) the listed output. v1 used the identity key for both.
   */
  listingKey?: string
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

const SIGNED_FIELD_COUNT: Record<MarketOfferVersion, number> = { 1: 19, 2: 20 }
const OP_CHECKSIG = 0xac
const OP_2DROP = 0x6d
const OP_DROP = 0x75
const OP_0 = 0x00
const OP_1NEGATE = 0x4f
const OP_1 = 0x51
const utf8 = (value: string): number[] => Utils.toArray(value, 'utf8')
const text = (value: number[]): string =>
  new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(value))

/**
 * Bitcoin's MINIMALDATA policy requires one-byte script numbers to use their
 * dedicated opcodes. Script.writeBin([1]) emits `01 01`, which is valid data
 * but non-minimal; spending that output then fails before the offer cleanup
 * runs. PushDrop.decode maps these opcodes back to the original field bytes.
 */
function writeMinimalBin(script: Script, value: number[]): void {
  if (value.length === 0) {
    script.writeOpCode(OP_0)
  } else if (value.length === 1 && value[0] === 0x81) {
    script.writeOpCode(OP_1NEGATE)
  } else if (value.length === 1 && value[0]! >= 1 && value[0]! <= 16) {
    script.writeOpCode(OP_1 - 1 + value[0]!)
  } else {
    script.writeBin(value)
  }
}

function chunkIsMinimalPush(chunk: { op?: number; data?: number[] }): boolean {
  const data = chunk.data ?? []
  const op = chunk.op
  // Script parsing represents dedicated numeric pushes as opcode-only chunks;
  // PushDrop.decode reconstructs their canonical stack bytes.
  if (
    data.length === 0 &&
    (op === OP_0 || op === OP_1NEGATE || (op != null && op >= OP_1 && op <= 0x60))
  ) {
    return true
  }
  if (data.length === 0) return op === OP_0
  if (data.length === 1 && data[0] === 0x81) return op === OP_1NEGATE
  if (data.length === 1 && data[0]! >= 1 && data[0]! <= 16) {
    return op === OP_1 - 1 + data[0]!
  }
  if (data.length <= 75) return op === data.length
  if (data.length <= 0xff) return op === 0x4c
  if (data.length <= 0xffff) return op === 0x4d
  return op === 0x4e
}

/** Pushed fields including the signature, and the drops that follow them. */
function offerShape(pushes: number): number {
  return 2 + pushes + Math.ceil(pushes / 2)
}

export function marketOfferUsesMinimalPushes(lockingScriptHex: string): boolean {
  try {
    const chunks = Script.fromHex(lockingScriptHex.trim().toLowerCase()).chunks
    const pushes = ([1, 2] as const)
      .map((v) => SIGNED_FIELD_COUNT[v] + 1)
      .find((n) => chunks.length === offerShape(n))
    return pushes != null && chunks.slice(2, 2 + pushes).every(chunkIsMinimalPush)
  } catch {
    return false
  }
}

/** The child of `seller` a v2 offer signature verifies under (BRC-3, counterparty `anyone`). */
export function marketOfferSignerKey(sellerIdentityKey: string): PublicKey {
  return new KeyDeriver('anyone').derivePublicKey(
    MARKET_OFFER_SIGNATURE_PROTOCOL,
    MARKET_OFFER_SIGNATURE_KEY_ID,
    sellerIdentityKey,
  )
}

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
  const version: MarketOfferVersion = value.version === 1 ? 1 : MARKET_OFFER_VERSION
  const payTo = value.payTo.trim()
  const feePayTo = value.feePayTo.trim()
  const identityAddress = PublicKey.fromString(sellerIdentityKey).toAddress('mainnet')
  let listingKey: string | undefined
  if (version === 1) {
    if (identityAddress !== payTo) throw new Error('Offer payTo does not match seller identity')
  } else {
    // A BRC-100 wallet never signs with its identity key, so v2 holds nothing there.
    if (!value.listingKey) throw new Error('Offer listing key is missing')
    listingKey = PublicKey.fromString(value.listingKey.trim().toLowerCase()).toString()
    if (listingKey === sellerIdentityKey) throw new Error('Offer listing key is the seller identity key')
    if (payTo === identityAddress) throw new Error('Offer payTo is the seller identity address')
    new P2PKH().lock(payTo)
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
    version,
    itemVout: MARKET_ITEM_VOUT,
    sellerIdentityKey,
    ...(listingKey ? { listingKey } : {}),
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
    ...(f.version === 2 ? [Utils.toArray(f.listingKey!, 'hex')] : []),
  ]
}

/** The key that locks the offer token: the listing key (v2) or the identity key (v1). */
export function marketOfferLockKey(fields: MarketOfferFields): string {
  return fields.version === 2 ? fields.listingKey! : fields.sellerIdentityKey
}

/**
 * Final BRC-48 PushDrop wire format shared with tm_1sat_market.
 *
 * The seller signs the concatenated binary fields. A v2 offer is signed the way
 * BRC-100 `createSignature` signs (protocol `1sat market offer`, key ID `1`,
 * counterparty `anyone`) and locked to the listing key, so any BRC-100 wallet
 * can write and cancel one. `rootKey` is the seller's root; v1 signs with it raw.
 */
export function encodeMarketOffer(fields: MarketOfferFields, rootKey: PrivateKey): string {
  const normalized = normalizeMarketOfferFields(fields)
  if (rootKey.toPublicKey().toString() !== normalized.sellerIdentityKey) {
    throw new Error('Offer signing key does not match seller identity')
  }
  const offerFields = marketOfferFieldBytes(normalized)
  const signer =
    normalized.version === 2
      ? new KeyDeriver(rootKey).derivePrivateKey(MARKET_OFFER_SIGNATURE_PROTOCOL, MARKET_OFFER_SIGNATURE_KEY_ID, 'anyone')
      : rootKey
  const encodedSignature = signer.sign(offerFields.flat()).toDER()
  const signature =
    typeof encodedSignature === 'string'
      ? Utils.toArray(encodedSignature, 'hex')
      : encodedSignature
  const pushes = [...offerFields, signature]
  const script = new Script()
  script.writeBin(Utils.toArray(marketOfferLockKey(normalized), 'hex'))
  script.writeOpCode(OP_CHECKSIG)
  for (const field of pushes) writeMinimalBin(script, field)
  for (let i = 0; i < Math.floor(pushes.length / 2); i++) script.writeOpCode(OP_2DROP)
  if (pushes.length % 2) script.writeOpCode(OP_DROP)
  return script.toHex()
}

export function parseMarketOffer(lockingScriptHex: string): MarketOfferFields {
  if (!marketOfferUsesMinimalPushes(lockingScriptHex)) {
    throw new Error('Market offer uses non-minimal data pushes — seller must relist')
  }
  let decoded: ReturnType<typeof PushDrop.decode>
  try {
    decoded = PushDrop.decode(Script.fromHex(lockingScriptHex.trim().toLowerCase()), 'before')
  } catch {
    throw new Error('Invalid market offer PushDrop')
  }
  const raw = decoded.fields.map((field) => [...field])
  const version = raw[1]?.length === 1 ? raw[1][0] : -1
  if ((version !== 1 && version !== 2) || raw.length !== SIGNED_FIELD_COUNT[version] + 1) {
    throw new Error('Invalid market offer field count')
  }
  const expiresAt = readUnsigned(raw[15]!, 8)
  const parsed = normalizeMarketOfferFields({
    version,
    ...(version === 2 ? { listingKey: Utils.toHex(raw[19]!) } : {}),
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
    readUnsigned(raw[1]!, 1) !== version ||
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
  if (decoded.lockingPublicKey.toString().toLowerCase() !== marketOfferLockKey(parsed)) {
    throw new Error('Offer seller control mismatch')
  }
  const signed = SIGNED_FIELD_COUNT[version]
  const signerKey =
    version === 2 ? marketOfferSignerKey(parsed.sellerIdentityKey) : decoded.lockingPublicKey
  try {
    const signature = Signature.fromDER(raw[signed]!)
    if (!signerKey.verify(raw.slice(0, signed).flat(), signature)) {
      throw new Error('Invalid market offer signature')
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'Invalid market offer signature') throw error
    throw new Error('Invalid market offer signature')
  }
  return parsed
}
