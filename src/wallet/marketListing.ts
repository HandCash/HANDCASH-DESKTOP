import {
  BigNumber,
  Hash,
  PrivateKey,
  PublicKey,
  Signature,
  Utils,
} from '@bsv/sdk'
import { normalizeAppHost } from './appIdentity'
import { getActiveWallet } from './session'
import { durableGetItem, durableSetItem } from './durableStorage'
import {
  parseProvenanceV2,
  tryBuildProvenanceV2,
  verifyProvenanceV2Async,
  type ProvenanceV2,
} from './oneSatProvenance'
import { getBeefForTxidCached } from './beefCache'
import {
  MARKET_FEE_BASIS_POINTS,
  MARKET_FEE_IDENTITY_KEY,
  MARKET_FEE_PAY_TO_ADDRESS,
} from './walletConfig'
import { recordWalletEvent } from './appActivity'

export const MARKET_LISTING_PROTOCOL = 'HandCash-Market-Listing-v2'
export const MARKET_PURCHASE_INTENT_PROTOCOL =
  'HandCash-Market-Purchase-Intent-v1'
export const MARKET_SETTLEMENT_RECEIPT_PROTOCOL =
  'HandCash-Market-Settlement-Receipt-v1'
export const MARKET_PROVENANCE_VERSION = 2 as const
const LISTING_AUTH_STORAGE_KEY = 'handcash.market.listingAuthorizations.v2'

export type MarketListingAdvert = {
  outpoint: string
  assetType: 'ordinal' | 'bsv21'
  seller: string
  payTo: string
  priceSats: number
  feeIdentityKey: string
  feeBasisPoints: number
  origin: string
  provenanceHash: string
  provenanceSize: number
  provenanceVersion: 2
  listedAt: number
  expiresAt: number | null
  nonce: string
  signature: string
}

export type CreateMarketListingArgs = {
  outpoint: string
  assetType?: 'ordinal' | 'bsv21'
  priceSats: number
  expiresAt?: number | null
}

export type MarketListingPostPayload = {
  listing: MarketListingAdvert
  provenance: ProvenanceV2
}

export type MarketPurchaseIntent = {
  intentId: string
  outpoint: string
  buyer: string
  seller: string
  priceSats: number
  feeSats: number
  totalSats: number
  provenanceHash: string
  createdAt: number
  expiresAt: number | null
  nonce: string
  signature: string
}

export type MarketSettlementReceipt = {
  receiptId: string
  intentId: string
  outpoint: string
  buyer: string
  seller: string
  settlementTxid: string
  sellerOutputIndex: number
  feeOutputIndex: number
  settledAt: number
  signature: string
}

export type MarketCancelAdvert = {
  protocol: typeof MARKET_LISTING_PROTOCOL
  action: 'cancel'
  outpoint: string
  nonce: string
  seller: string
  cancelledAt: number
  signature: string
}

export type MarketListingState =
  | 'active'
  | 'cancelled'
  | 'reserved'
  | 'settled'
  | 'failed'

export type MarketListingAuthorization = {
  key: string
  outpoint: string
  nonce: string
  seller: string
  origin: string
  provenanceHash: string
  priceSats: number
  state: MarketListingState
  createdAt: number
  updatedAt: number
  reason?: string
  reservationSaleId?: string
  reservationBuyer?: string
  reservationUntil?: number
  reservationTxCommitment?: string
  reservationIntent?: MarketPurchaseIntent
  listing?: MarketListingAdvert
}

export class MarketListingError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'MarketListingError'
  }
}

export function isMarketListingOrigin(origin: string | undefined): boolean {
  const host = normalizeAppHost(origin)
  const bare = (host.split(':')[0] ?? host).toLowerCase()
  return (
    bare === 'localhost' ||
    bare === '127.0.0.1' ||
    bare === 'handcash.io' ||
    bare === 'www.handcash.io' ||
    bare === 'market.handcash.io' ||
    bare === 'preprod-market.handcash.io' ||
    bare === 'market-v2.handcash.io'
  )
}

export function listingPreimage(
  advert: Omit<MarketListingAdvert, 'signature'>
): string {
  return [
    MARKET_LISTING_PROTOCOL,
    'list',
    advert.outpoint,
    advert.assetType,
    advert.seller,
    advert.payTo,
    String(advert.priceSats),
    advert.feeIdentityKey,
    String(advert.feeBasisPoints),
    advert.origin,
    advert.provenanceHash,
    String(advert.provenanceSize),
    String(advert.provenanceVersion),
    String(advert.listedAt),
    advert.expiresAt == null ? '' : String(advert.expiresAt),
    advert.nonce,
  ].join('\n')
}

/** Field order is protocol and mirrors BRC-CLOUD/src/listingAdvert.js. */
export function purchaseIntentPreimage(
  intent: Omit<MarketPurchaseIntent, 'signature'>
): string {
  return [
    MARKET_PURCHASE_INTENT_PROTOCOL,
    intent.intentId,
    intent.outpoint,
    intent.buyer,
    intent.seller,
    String(intent.priceSats),
    String(intent.feeSats),
    String(intent.totalSats),
    intent.provenanceHash,
    String(intent.createdAt),
    intent.expiresAt == null ? '' : String(intent.expiresAt),
    intent.nonce,
  ].join('\n')
}

/** Field order is protocol and mirrors BRC-CLOUD/src/listingAdvert.js. */
export function settlementReceiptPreimage(
  receipt: Omit<MarketSettlementReceipt, 'signature'>
): string {
  return [
    MARKET_SETTLEMENT_RECEIPT_PROTOCOL,
    receipt.receiptId,
    receipt.intentId,
    receipt.outpoint,
    receipt.buyer,
    receipt.seller,
    receipt.settlementTxid,
    String(receipt.sellerOutputIndex),
    String(receipt.feeOutputIndex),
    String(receipt.settledAt),
  ].join('\n')
}

function normalizeOutpoint(value: unknown): string {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
  const match = /^([0-9a-f]{64})[._](0|[1-9]\d*)$/.exec(raw)
  if (!match)
    throw new Error(
      'Listing outpoint must be a transaction id and output index'
    )
  return `${match[1]}_${match[2]}`
}

function normalizeOriginOutpoint(value: unknown): string {
  try {
    return normalizeOutpoint(value)
  } catch {
    throw new MarketListingError(
      'ITEM_ORIGIN_UNPROVEN',
      'The listed item has no valid BRC-150 origin.'
    )
  }
}

function randomNonce(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return Utils.toHex([...bytes])
}

/** RFC-8785-style ordering for the JSON-compatible BRC-150 value shape. */
export function deterministicJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite JSON number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(deterministicJson).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const body = value as Record<string, unknown>
    return `{${Object.keys(body)
      .filter((key) => body[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${deterministicJson(body[key])}`)
      .join(',')}}`
  }
  throw new Error('Value is not JSON serializable')
}

export function hashMarketProvenance(provenance: ProvenanceV2): {
  json: string
  hash: string
  size: number
} {
  const json = deterministicJson(provenance)
  const bytes = Utils.toArray(json, 'utf8')
  return {
    json,
    hash: Utils.toHex(Hash.sha256(bytes)),
    size: bytes.length,
  }
}

function rawSignatureHex(rootKeyHex: string, preimage: string): string {
  const signature = PrivateKey.fromHex(rootKeyHex).sign(
    Utils.toArray(preimage, 'utf8'),
    undefined,
    true
  )
  return Utils.toHex([
    ...signature.r.toArray('be', 32),
    ...signature.s.toArray('be', 32),
  ])
}

function verifyRawSignature(
  identityKey: string,
  signatureHex: string,
  preimage: string
): boolean {
  try {
    const bytes = Utils.toArray(signatureHex, 'hex')
    if (bytes.length !== 64) return false
    const signature = new Signature(
      new BigNumber(bytes.slice(0, 32)),
      new BigNumber(bytes.slice(32))
    )
    return signature.verify(
      Utils.toArray(preimage, 'utf8'),
      PublicKey.fromString(identityKey)
    )
  } catch {
    return false
  }
}

export function verifyMarketPurchaseIntent(
  intent: MarketPurchaseIntent,
  listing: MarketListingAdvert,
  now = Date.now()
): boolean {
  const amounts = calculateMarketSettlement(listing.priceSats)
  return (
    intent.outpoint === listing.outpoint &&
    intent.seller.toLowerCase() === listing.seller.toLowerCase() &&
    intent.priceSats === amounts.priceSats &&
    intent.feeSats === amounts.feeSats &&
    intent.totalSats === amounts.priceSats &&
    intent.provenanceHash.toLowerCase() === listing.provenanceHash.toLowerCase() &&
    intent.nonce.toLowerCase() === listing.nonce.toLowerCase() &&
    Number.isSafeInteger(intent.createdAt) &&
    Math.abs(now - intent.createdAt) <= 5 * 60_000 &&
    intent.expiresAt != null &&
    intent.expiresAt > now &&
    verifyRawSignature(
      intent.buyer,
      intent.signature,
      purchaseIntentPreimage(intent)
    )
  )
}

export function verifyMarketSettlementReceipt(
  receipt: MarketSettlementReceipt,
  intent: MarketPurchaseIntent,
  now = Date.now()
): boolean {
  return (
    receipt.intentId === intent.intentId &&
    receipt.outpoint === intent.outpoint &&
    receipt.buyer.toLowerCase() === intent.buyer.toLowerCase() &&
    receipt.seller.toLowerCase() === intent.seller.toLowerCase() &&
    /^[0-9a-f]{64}$/i.test(receipt.settlementTxid) &&
    receipt.sellerOutputIndex === 1 &&
    receipt.feeOutputIndex === 2 &&
    Number.isSafeInteger(receipt.settledAt) &&
    Math.abs(now - receipt.settledAt) <= 5 * 60_000 &&
    verifyRawSignature(
      receipt.seller,
      receipt.signature,
      settlementReceiptPreimage(receipt)
    )
  )
}

function listingAuthorizationKey(outpoint: string, nonce: string): string {
  return `${normalizeOutpoint(outpoint)}:${nonce.trim().toLowerCase()}`
}

function readAuthorizations(): MarketListingAuthorization[] {
  try {
    const parsed = JSON.parse(
      durableGetItem(LISTING_AUTH_STORAGE_KEY) ?? '[]'
    ) as unknown
    return Array.isArray(parsed)
      ? parsed.filter(
          (entry): entry is MarketListingAuthorization =>
            !!entry &&
            typeof entry === 'object' &&
            typeof (entry as MarketListingAuthorization).key === 'string'
        )
      : []
  } catch {
    return []
  }
}

function writeAuthorizations(records: MarketListingAuthorization[]): void {
  durableSetItem(LISTING_AUTH_STORAGE_KEY, JSON.stringify(records))
}

function saveAuthorization(record: MarketListingAuthorization): void {
  const records = readAuthorizations().filter((item) => item.key !== record.key)
  writeAuthorizations([...records, record])
}

export function updateMarketListingAuthorization(args: {
  outpoint: string
  nonce: string
  from: MarketListingState[]
  to: MarketListingState
  reason?: string
}): MarketListingAuthorization {
  const current = getMarketListingAuthorization(args)
  if (!current || !args.from.includes(current.state)) {
    throw new MarketListingError(
      current ? 'LISTING_NOT_ACTIVE' : 'LISTING_NOT_AUTHORIZED',
      current ? `Listing is ${current.state}.` : 'Listing not found.'
    )
  }
  const next = {
    ...current,
    state: args.to,
    updatedAt: Date.now(),
    ...(args.reason ? { reason: args.reason } : {}),
  }
  saveAuthorization(next)
  return next
}

export function reserveMarketListingAuthorization(args: {
  outpoint: string
  nonce: string
  saleId: string
  buyerIdentityKey: string
  expiresAt: number
  txCommitment: string
  intent: MarketPurchaseIntent
}): MarketListingAuthorization {
  let current = getMarketListingAuthorization(args)
  if (
    current?.state === 'reserved' &&
    typeof current.reservationUntil === 'number' &&
    current.reservationUntil <= Date.now()
  ) {
    current = {
      ...current,
      state: 'active',
      updatedAt: Date.now(),
      reason: 'reservation-expired',
      reservationSaleId: undefined,
      reservationBuyer: undefined,
      reservationUntil: undefined,
      reservationTxCommitment: undefined,
      reservationIntent: undefined,
    }
    saveAuthorization(current)
  }
  if (!current || current.state !== 'active') {
    const competing =
      current?.state === 'reserved' && current.reservationSaleId !== args.saleId
    throw new MarketListingError(
      competing ? 'COMPETING_BUYER' : 'DUPLICATE_OR_INACTIVE_LISTING',
      competing
        ? 'Another buyer has reserved this listing.'
        : 'Listing is not active.'
    )
  }
  const reserved: MarketListingAuthorization = {
    ...current,
    state: 'reserved',
    updatedAt: Date.now(),
    reason: 'buyer-reserved',
    reservationSaleId: args.saleId,
    reservationBuyer: args.buyerIdentityKey.toLowerCase(),
    reservationUntil: args.expiresAt,
    reservationTxCommitment: args.txCommitment,
    reservationIntent: args.intent,
  }
  saveAuthorization(reserved)
  return reserved
}

export function findMarketListingAuthorizationBySaleId(
  saleId: string
): MarketListingAuthorization | null {
  return (
    readAuthorizations().find(
      (item) => item.state === 'reserved' && item.reservationSaleId === saleId
    ) ?? null
  )
}

function parseCustomInstructions(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const value = JSON.parse(raw) as unknown
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

async function loadListedOutput(outpoint: string) {
  const active = getActiveWallet()
  if (!active) throw new MarketListingError('WALLET_LOCKED', 'Wallet locked')
  const listed = await active.wallet.listOutputs({
    basket: '1sat',
    limit: 10_000,
    includeTags: true,
    includeCustomInstructions: true,
    include: 'locking scripts',
    seekPermission: false,
  })
  const output = (listed.outputs ?? []).find(
    (candidate) => normalizeOutpoint(candidate.outpoint) === outpoint
  )
  if (!output) {
    throw new MarketListingError(
      'ITEM_NOT_HELD',
      'The listed item is no longer held by this wallet.'
    )
  }
  if ((output.satoshis ?? 1) !== 1) {
    throw new MarketListingError(
      'ITEM_NOT_ORDINAL',
      'The listed output is not a one-satoshi item.'
    )
  }
  return { active, output }
}

export async function createMarketListingAdvert(
  args: CreateMarketListingArgs
): Promise<MarketListingPostPayload> {
  const outpoint = normalizeOutpoint(args.outpoint)
  const { active, output } = await loadListedOutput(outpoint)
  const priceSats = Math.trunc(Number(args.priceSats))
  if (!Number.isSafeInteger(priceSats) || priceSats < 20) {
    throw new Error('Listing price must be at least 20 satoshis')
  }
  const listedAt = Date.now()
  const expiresAt =
    args.expiresAt == null ? null : Math.trunc(Number(args.expiresAt))
  if (
    expiresAt != null &&
    (!Number.isSafeInteger(expiresAt) || expiresAt <= listedAt)
  ) {
    throw new Error('Listing expiry must be in the future')
  }

  const custom = parseCustomInstructions(output.customInstructions)
  const origin = normalizeOriginOutpoint(custom.origin)
  const provenance = await tryBuildProvenanceV2({
    tipOutpoint: outpoint,
    origin,
    wallet: active,
    priorProvenance: custom.provenance,
    allowLineageHydrate: true,
  })
  if (!provenance) {
    throw new MarketListingError(
      'ITEM_ORIGIN_UNPROVEN',
      'A complete BRC-150 proof could not be built for this item.'
    )
  }
  const verified = await verifyProvenanceV2Async(provenance, outpoint, {
    enforceBudget: false,
    getBeef: (txid) => getBeefForTxidCached(active, txid),
  })
  if (!verified.proven) {
    throw new MarketListingError(
      'ITEM_ORIGIN_UNPROVEN',
      `BRC-150 verification failed: ${verified.reason ?? 'unknown reason'}`
    )
  }
  const digest = hashMarketProvenance(provenance)
  const nonce = randomNonce()
  const unsigned: Omit<MarketListingAdvert, 'signature'> = {
    outpoint,
    assetType: args.assetType === 'bsv21' ? 'bsv21' : 'ordinal',
    seller: active.identityKey.toLowerCase(),
    payTo: active.address,
    priceSats,
    feeIdentityKey: MARKET_FEE_IDENTITY_KEY.toLowerCase(),
    feeBasisPoints: MARKET_FEE_BASIS_POINTS,
    origin,
    provenanceHash: digest.hash,
    provenanceSize: digest.size,
    provenanceVersion: MARKET_PROVENANCE_VERSION,
    listedAt,
    expiresAt,
    nonce,
  }
  const advert = {
    ...unsigned,
    signature: rawSignatureHex(active.rootKeyHex, listingPreimage(unsigned)),
  }
  saveAuthorization({
    key: listingAuthorizationKey(outpoint, nonce),
    outpoint,
    nonce,
    seller: advert.seller,
    origin,
    provenanceHash: digest.hash,
    priceSats,
    state: 'active',
    createdAt: listedAt,
    updatedAt: listedAt,
    listing: advert,
  })
  recordWalletEvent({
    method: 'market-list',
    note: `Listed collectable for ${priceSats.toLocaleString()} sats`,
  })
  return { listing: advert, provenance }
}

function verifyAdvertSignature(advert: MarketListingAdvert): boolean {
  try {
    const bytes = Utils.toArray(advert.signature, 'hex')
    if (bytes.length !== 64) return false
    const signature = new Signature(
      new BigNumber(bytes.slice(0, 32)),
      new BigNumber(bytes.slice(32))
    )
    return signature.verify(
      Utils.toArray(listingPreimage(advert), 'utf8'),
      PublicKey.fromString(advert.seller)
    )
  } catch {
    return false
  }
}

export async function verifyMarketListingProvenance(args: {
  listing: MarketListingAdvert
  provenance: unknown
}): Promise<{ verified: boolean; reason: string | null }> {
  const advert = args.listing
  const provenance = parseProvenanceV2(args.provenance)
  const fail = (reason: string) => ({ verified: false, reason })
  if (!provenance || advert.provenanceVersion !== 2) {
    return fail('INVALID_PROVENANCE_VERSION')
  }
  let outpoint: string
  try {
    outpoint = normalizeOutpoint(advert.outpoint)
  } catch (err) {
    return fail(
      `INVALID_LISTED_OUTPUT: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }
  const digest = hashMarketProvenance(provenance)
  if (
    digest.hash !== advert.provenanceHash.toLowerCase() ||
    digest.size !== advert.provenanceSize
  ) {
    return fail('PROVENANCE_COMMITMENT_MISMATCH')
  }
  try {
    if (
      normalizeOriginOutpoint(provenance.origin) !==
      normalizeOriginOutpoint(advert.origin)
    ) {
      return fail('PROVENANCE_ORIGIN_MISMATCH')
    }
  } catch {
    return fail('PROVENANCE_ORIGIN_MISMATCH')
  }
  if (
    advert.feeIdentityKey.toLowerCase() !==
      MARKET_FEE_IDENTITY_KEY.toLowerCase() ||
    advert.feeBasisPoints !== MARKET_FEE_BASIS_POINTS
  ) {
    return fail('MARKET_FEE_TERMS_MISMATCH')
  }
  if (
    !Number.isSafeInteger(advert.priceSats) ||
    advert.priceSats < 20 ||
    (advert.expiresAt != null && advert.expiresAt <= Date.now())
  ) {
    return fail('INVALID_LISTING_TERMS')
  }
  if (!verifyAdvertSignature(advert)) {
    return fail('INVALID_LISTING_SIGNATURE')
  }
  const active = getActiveWallet()
  const verified = await verifyProvenanceV2Async(provenance, outpoint, {
    enforceBudget: false,
    ...(active
      ? { getBeef: (txid: string) => getBeefForTxidCached(active, txid) }
      : {}),
  })
  return verified.proven
    ? { verified: true, reason: null }
    : fail(`ITEM_ORIGIN_UNPROVEN: ${verified.reason ?? 'unknown reason'}`)
}

export function calculateMarketSettlement(priceSats: number): {
  priceSats: number
  sellerSats: number
  feeSats: number
} {
  const price = Math.trunc(Number(priceSats))
  if (!Number.isSafeInteger(price) || price < 20) {
    throw new MarketListingError(
      'INVALID_MARKET_PRICE',
      'Market price must be at least 20 satoshis.'
    )
  }
  // Fee is included in the buyer's total; remainder always belongs to seller.
  const feeSats = Math.floor((price * MARKET_FEE_BASIS_POINTS) / 10_000)
  return { priceSats: price, sellerSats: price - feeSats, feeSats }
}

export function marketFeePayToAddress(
  listing: Pick<MarketListingAdvert, 'feeIdentityKey' | 'feeBasisPoints'>
): string {
  if (
    listing.feeIdentityKey.toLowerCase() !==
      MARKET_FEE_IDENTITY_KEY.toLowerCase() ||
    listing.feeBasisPoints !== MARKET_FEE_BASIS_POINTS
  ) {
    throw new MarketListingError(
      'MARKET_FEE_TERMS_MISMATCH',
      'Listing market fee terms do not match this wallet.'
    )
  }
  const derived = PublicKey.fromString(listing.feeIdentityKey).toAddress(
    'mainnet'
  )
  if (derived !== MARKET_FEE_PAY_TO_ADDRESS) {
    throw new MarketListingError(
      'MARKET_FEE_ADDRESS_MISMATCH',
      'Listing fee identity does not derive the configured market address.'
    )
  }
  return derived
}

export async function createMarketPurchaseIntent(args: {
  listing: MarketListingAdvert
  provenance: unknown
}): Promise<MarketPurchaseIntent> {
  const active = getActiveWallet()
  if (!active) throw new MarketListingError('WALLET_LOCKED', 'Wallet locked')
  if (active.chain !== 'main') {
    throw new MarketListingError(
      'MARKET_CHAIN_MISMATCH',
      'Market settlement is mainnet only.'
    )
  }
  const proof = await verifyMarketListingProvenance(args)
  if (!proof.verified) {
    throw new MarketListingError(
      'ITEM_ORIGIN_UNPROVEN',
      proof.reason ?? 'Listing provenance is invalid.'
    )
  }
  marketFeePayToAddress(args.listing)
  const amounts = calculateMarketSettlement(args.listing.priceSats)
  const createdAt = Date.now()
  const unsigned: Omit<MarketPurchaseIntent, 'signature'> = {
    intentId: randomNonce(),
    outpoint: args.listing.outpoint,
    buyer: active.identityKey.toLowerCase(),
    seller: args.listing.seller.toLowerCase(),
    priceSats: amounts.priceSats,
    feeSats: amounts.feeSats,
    totalSats: amounts.priceSats,
    provenanceHash: args.listing.provenanceHash.toLowerCase(),
    createdAt,
    expiresAt: createdAt + 90_000,
    nonce: args.listing.nonce.toLowerCase(),
  }
  return {
    ...unsigned,
    signature: rawSignatureHex(
      active.rootKeyHex,
      purchaseIntentPreimage(unsigned)
    ),
  }
}

export function createMarketSettlementReceipt(args: {
  intent: MarketPurchaseIntent
  settlementTxid: string
  sellerOutputIndex: number
  feeOutputIndex: number
}): MarketSettlementReceipt {
  const active = getActiveWallet()
  if (!active) throw new MarketListingError('WALLET_LOCKED', 'Wallet locked')
  if (
    active.identityKey.toLowerCase() !== args.intent.seller.toLowerCase() ||
    args.sellerOutputIndex !== 1 ||
    args.feeOutputIndex !== 2
  ) {
    throw new MarketListingError(
      'MARKET_RECEIPT_TERMS_MISMATCH',
      'Settlement receipt does not match the seller or exact output indices.'
    )
  }
  const unsigned: Omit<MarketSettlementReceipt, 'signature'> = {
    receiptId: randomNonce(),
    intentId: args.intent.intentId,
    outpoint: args.intent.outpoint,
    buyer: args.intent.buyer,
    seller: args.intent.seller,
    settlementTxid: args.settlementTxid.toLowerCase(),
    sellerOutputIndex: args.sellerOutputIndex,
    feeOutputIndex: args.feeOutputIndex,
    settledAt: Date.now(),
  }
  return {
    ...unsigned,
    signature: rawSignatureHex(
      active.rootKeyHex,
      settlementReceiptPreimage(unsigned)
    ),
  }
}

export function getMarketListingAuthorization(args: {
  outpoint: string
  nonce?: string
}): MarketListingAuthorization | null {
  const outpoint = normalizeOutpoint(args.outpoint)
  const records = readAuthorizations()
    .filter(
      (item) =>
        item.outpoint === outpoint &&
        (!args.nonce || item.nonce === args.nonce.toLowerCase())
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const current = records[0] ?? null
  if (
    current?.state === 'reserved' &&
    typeof current.reservationUntil === 'number' &&
    current.reservationUntil <= Date.now()
  ) {
    const released: MarketListingAuthorization = {
      ...current,
      state: 'active',
      updatedAt: Date.now(),
      reason: 'reservation-expired',
      reservationSaleId: undefined,
      reservationBuyer: undefined,
      reservationUntil: undefined,
      reservationTxCommitment: undefined,
      reservationIntent: undefined,
    }
    saveAuthorization(released)
    return released
  }
  return current
}

export function getMarketSaleStatus(args: { outpoint: string }): {
  status: MarketListingState | 'not-found'
  listing: MarketListingAdvert | null
} {
  const authorization = getMarketListingAuthorization(args)
  return {
    status: authorization?.state ?? 'not-found',
    listing: authorization?.listing ?? null,
  }
}

export function cancelMarketListing(args: {
  outpoint: string
  nonce: string
}): MarketListingAuthorization {
  const active = getActiveWallet()
  if (!active) throw new MarketListingError('WALLET_LOCKED', 'Wallet locked')
  const current = getMarketListingAuthorization(args)
  if (!current || current.seller !== active.identityKey.toLowerCase()) {
    throw new MarketListingError(
      'LISTING_NOT_AUTHORIZED',
      'This wallet did not authorize that listing.'
    )
  }
  if (current.state !== 'active') {
    throw new MarketListingError(
      'LISTING_NOT_ACTIVE',
      `Listing is already ${current.state}.`
    )
  }
  const cancelled = {
    ...current,
    state: 'cancelled' as const,
    updatedAt: Date.now(),
    reason: 'seller-cancelled',
  }
  saveAuthorization(cancelled)
  recordWalletEvent({
    method: 'market-cancel',
    note: 'Cancelled collectable listing',
  })
  return cancelled
}

export function createCancelMarketListingAdvert(args: {
  outpoint: string
  nonce?: string
}): MarketCancelAdvert {
  const current = getMarketListingAuthorization(args)
  if (!current) {
    throw new MarketListingError('LISTING_NOT_AUTHORIZED', 'Listing not found.')
  }
  const cancelled = cancelMarketListing({
    outpoint: current.outpoint,
    nonce: current.nonce,
  })
  const active = getActiveWallet()!
  const unsigned = {
    protocol: MARKET_LISTING_PROTOCOL as typeof MARKET_LISTING_PROTOCOL,
    action: 'cancel' as const,
    outpoint: cancelled.outpoint,
    nonce: cancelled.nonce,
    seller: cancelled.seller,
    cancelledAt: cancelled.updatedAt,
  }
  return {
    ...unsigned,
    signature: rawSignatureHex(
      active.rootKeyHex,
      [
        unsigned.protocol,
        unsigned.action,
        unsigned.outpoint,
        unsigned.nonce,
        unsigned.seller,
        String(unsigned.cancelledAt),
      ].join('\n')
    ),
  }
}

export type PurchaseMarketListingArgs = {
  listing: MarketListingAdvert
  provenance: unknown
  intent: MarketPurchaseIntent
  sellerMessagebox?: string
  buyerMessagebox?: string
}

export async function purchaseMarketListing(
  args: PurchaseMarketListingArgs
): Promise<{
  saleId: string
  status: string
  txid?: string
  intent: MarketPurchaseIntent
  receipt?: MarketSettlementReceipt
}> {
  const { executeMarketPurchase } = await import('./marketSettlement')
  return executeMarketPurchase(args)
}

export async function getMarketSettlementReceipt(args: {
  intent: MarketPurchaseIntent
}): Promise<MarketSettlementReceipt | null> {
  const { recoverMarketSettlementReceipt } = await import('./marketSettlement')
  return recoverMarketSettlementReceipt(args)
}
