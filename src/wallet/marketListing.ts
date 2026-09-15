import {
  Beef,
  BigNumber,
  Hash,
  LockingScript,
  P2PKH,
  PrivateKey,
  PublicKey,
  Signature,
  Transaction,
  UnlockingScript,
  Utils,
} from '@bsv/sdk'
import { createActor } from 'xstate'
import { marketListingMachine, mayAbortMarketListing } from '../machines/marketListingMachine'
import { normalizeAppHost } from './appIdentity'
import { getActiveWallet, type ActiveWallet } from './session'
import { durableGetItem, durableSetItem } from './durableStorage'
import { runExclusiveSpend } from './spendGuard'
import {
  buildCollectableCustomInstructions,
  completeProvenanceForPublish,
  getRememberedProvenanceRemittance,
  parseProvenanceV2,
  provenanceMissingPathBodies,
  tryBuildProvenanceV2,
  verifyProvenanceForHeldTip,
  verifyProvenanceV2Async,
  type ProvenanceV2,
} from './oneSatProvenance'
import {
  buildBsv21SendRemittance,
  buildBsv21ValueLock,
  decodeBsv21Binary,
  decodeListedBsv21Tip,
  getTokenIconDataUrl,
  listBsv21BinaryTips,
  looksLikeOnesatFtTip,
  mergeIconTxIntoBeef,
  parseBsv21CustomInstructions,
  planBsv21Send,
  prove,
  tryParseProvenanceFromCi,
} from './token'
import { getBeefForTxidCached } from './beefCache'
import { getProvenVerdict } from './provenCache'
import { toUnderscoreOutpoint } from './outpointFormat'
import {
  MARKET_FEE_BASIS_POINTS,
  MARKET_FEE_IDENTITY_KEY,
  MARKET_FEE_PAY_TO_ADDRESS,
} from './walletConfig'
import {
  failMarketListingActivity,
  recordWalletEvent,
  removeActivityById,
  type ActivityEntry,
} from './appActivity'
import { getCachedCollectables } from './collectables'
import { rememberGhostTx } from './ghostTxSuppress'
import { scheduleHistoryBackupPush } from './deviceSync'
import { submitAtomicBeefToMiners } from './minerSubmit'
import {
  encodeMarketOffer,
  MARKET_ITEM_VOUT,
  MARKET_MAX_PROVENANCE_JSON_BYTES,
  MARKET_OFFER_DEPOSIT_SATS,
  MARKET_OFFER_VOUT,
  MARKET_OVERLAY_HYDRATE_MAX_TXS,
  normalizeMarketOfferFields,
  parseMarketOffer,
  type MarketOfferFields,
} from './marketOverlayProtocol'
import {
  chooseMarketCancelPath,
  chooseMarketListingPath,
} from './marketListingPath'
import { publicMessageboxBase } from './messageTransport'

export const MARKET_PURCHASE_INTENT_PROTOCOL =
  'HandCash-Market-Purchase-Intent-v1'
export const MARKET_SETTLEMENT_RECEIPT_PROTOCOL =
  'HandCash-Market-Settlement-Receipt-v1'
export const MARKET_PROVENANCE_VERSION = 2 as const
const LISTING_AUTH_STORAGE_KEY = 'handcash.market.listingAuthorizations.v2'

export type MarketListingAdvert = {
  outpoint: string
  offerOutpoint: string
  offerLockingScript: string
  assetType: 'ordinal' | 'bsv21'
  amt?: number
  seller: string
  payTo: string
  priceSats: number
  feeIdentityKey: string
  feePayTo: string
  feeBasisPoints: number
  exactFeeSats: number
  depositSats: 1
  messagebox: string
  origin: string
  provenanceHash: string
  provenanceSize: number
  provenanceVersion: 2
  listedAt: number
  expiresAt: number | null
  nonce: string
  /** Overlay-admitted listing BEEF. Prefer this over indexer getBeefForTxid. */
  listingBeefB64?: string | null
  /**
   * List-time seller signatures so a buyer can settle without a live seller.
   * Required to publish: missing unlocks fail closed and the offer is cancelled.
   */
  settlementUnlocks?: MarketSettlementUnlocks | null
}

export type MarketSettlementUnlocks = {
  version: 1
  itemUnlockingScript: string
  offerUnlockingScript: string
  itemSighash: 'NONE|ANYONECANPAY'
  offerSighash: 'SINGLE|ANYONECANPAY'
  sellerSats: number
  feeSats: number
}

export type CreateMarketListingArgs = {
  outpoint: string
  assetType?: 'ordinal' | 'bsv21'
  priceSats: number
  /** BSV-21 units to list. Defaults to the whole tip. Remainder is 162 change. */
  listAmt?: number
  expiresAt?: number | null
  messagebox?: string | null
}

export type MarketListingPostPayload = {
  listing: MarketListingAdvert
  provenance: ProvenanceV2 | Bsv21ListingProof
  txid: string
  beef: number[]
  token: {
    outpoint: string
    outputIndex: 1
    satoshis: 1
    lockingScript: string
    fields: MarketOfferFields
  }
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
  action: 'cancel'
  itemOutpoint: string
  offerOutpoint: string
  txid: string
  beef: number[]
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
  settlementTxid?: string
  proceedsInternalized?: boolean
  itemRetired?: boolean
  listing?: MarketListingAdvert
}

export class MarketListingError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'MarketListingError'
  }
}


export type MarketAssetType = 'ordinal' | 'bsv21'

/** BRC-176 listing proof for 162 tips. Not BRC-150. */
export type Bsv21ListingProof = {
  v: 176
  tokenId: string
  amt: string
  deployOutpoint: string
  role: 'deploy' | 'value'
  tip: string
}

export function parseBsv21ListingProof(raw: unknown): Bsv21ListingProof | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (o.v !== 176) return null
  const tokenId = typeof o.tokenId === 'string' ? o.tokenId.trim().toLowerCase() : ''
  const amt = typeof o.amt === 'string' ? o.amt.trim() : ''
  const deployOutpoint =
    typeof o.deployOutpoint === 'string' ? o.deployOutpoint.trim().toLowerCase() : ''
  const tip = typeof o.tip === 'string' ? o.tip.trim().toLowerCase() : ''
  const role = o.role === 'deploy' || o.role === 'value' ? o.role : null
  if (!tokenId || !/^[0-9a-f]{64}_\d+$/.test(tokenId)) return null
  if (!amt || !/^\d+$/.test(amt) || amt === '0') return null
  if (!deployOutpoint || !role || !tip) return null
  return { v: 176, tokenId, amt, deployOutpoint, role, tip }
}

/**
 * Prove a 162 tip for market listing from the binary + 163 amt/id.
 * Optional BEEF is checked with BRC-176. Never walks BRC-150 FIFO.
 */
export function buildBsv21ListingProof(args: {
  outpoint: string
  lockingScriptHex: string
  customInstructions?: string
  beef?: Parameters<typeof prove>[1]
}): Bsv21ListingProof {
  const decoded = decodeBsv21Binary(args.lockingScriptHex)
  if (!decoded || decoded.amount <= 0n || decoded.role === 'authority') {
    throw new MarketListingError(
      'MARKET_ASSET_UNSUPPORTED',
      'BSV-21 listing requires a 162 value lock.',
    )
  }
  const tip = normalizeOutpoint(args.outpoint)
  const tokenId =
    decoded.tokenId?.toLowerCase() ??
    (decoded.role === 'deploy' ? tip : null)
  if (!tokenId) {
    throw new MarketListingError(
      'MARKET_ASSET_UNSUPPORTED',
      'BSV-21 listing requires a token id.',
    )
  }
  const ci = parseBsv21CustomInstructions(args.customInstructions)
  if (ci?.id) {
    const ciId = ci.id.trim().toLowerCase().replace(/\.(\d+)$/, '_$1')
    if (ciId !== tokenId) {
      throw new MarketListingError(
        'ITEM_ORIGIN_UNPROVEN',
        'BRC-163 token id does not match the 162 lock.',
      )
    }
  }
  if (ci?.amt && ci.amt !== decoded.amount.toString()) {
    throw new MarketListingError(
      'ITEM_ORIGIN_UNPROVEN',
      'BRC-163 amt does not match the 162 lock.',
    )
  }
  let deployOutpoint = decoded.role === 'deploy' ? tip : tokenId
  let role: 'deploy' | 'value' = decoded.role === 'deploy' ? 'deploy' : 'value'
  if (args.beef) {
    const result = prove(tip, args.beef)
    if (result.ok) {
      if (result.tokenId !== tokenId || result.amount !== decoded.amount) {
        throw new MarketListingError(
          'ITEM_ORIGIN_UNPROVEN',
          'BRC-176 proof does not match the 162 lock.',
        )
      }
      deployOutpoint = result.deployOutpoint
      role = result.role
    }
  }
  return {
    v: 176,
    tokenId,
    amt: decoded.amount.toString(),
    deployOutpoint,
    role,
    tip,
  }
}


/** Closed beta: market remittance is 163 / collectables, never 1sat-ft. */
export function assertNoOnesatFtRemittance(customInstructions: string): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(customInstructions)
  } catch {
    return
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
  const p = String((parsed as { p?: unknown }).p ?? '').toLowerCase()
  if (p === '1sat-ft') {
    throw new MarketListingError(
      'MARKET_ASSET_UNSUPPORTED',
      'Market listing refuses to create 1sat-ft remittance.',
    )
  }
}


function tagName(tags: string[] | undefined): string | undefined {
  const raw = (tags ?? []).find((tag) => tag.toLowerCase().startsWith('name:'))
  const name = raw ? raw.slice(raw.indexOf(':') + 1).trim() : ''
  return name || undefined
}

function listedActivityIdentity(args: {
  inputOutpoint: string
  origin: string
  listedAsset: MarketAssetType
  customName?: string
  tags?: string[]
  sym?: string
  icon?: string
}): { name: string; imageUrl?: string; app?: string } {
  const input = args.inputOutpoint.trim().toLowerCase().replace(/_/g, '.')
  const origin = args.origin.trim().toLowerCase().replace(/\./g, '_')
  const held = getCachedCollectables().find((c) => {
    const op = c.outpoint.trim().toLowerCase().replace(/_/g, '.')
    const og = c.origin.trim().toLowerCase().replace(/\./g, '_')
    return op === input || og === origin
  })
  if (args.listedAsset === 'bsv21') {
    const name = args.sym?.trim() || held?.name?.trim() || 'Token'
    const imageUrl = (args.icon ? getTokenIconDataUrl(args.icon) : undefined) || held?.imageUrl
    return { name, ...(imageUrl ? { imageUrl } : {}) }
  }
  const name =
    args.customName?.trim() ||
    held?.name?.trim() ||
    tagName(args.tags) ||
    'Collectable'
  return {
    name,
    ...(held?.imageUrl ? { imageUrl: held.imageUrl } : {}),
    ...(held?.app ? { app: held.app } : {}),
  }
}

/** Classify a held tip. 1sat-ft leftovers are refused; 162 / bsv21 is the fungible path. */
export function classifyMarketListingAsset(args: {
  outpoint: string
  satoshis?: number
  tags?: string[]
  customInstructions?: string
  lockingScriptHex?: string
}): {
  assetType: MarketAssetType
  tokenId?: string
  amt?: number
  refuse?: '1sat-ft'
} {
  if (
    looksLikeOnesatFtTip({
      tags: args.tags,
      customInstructions: args.customInstructions,
      lockingScriptHex: args.lockingScriptHex,
    })
  ) {
    return { assetType: 'ordinal', refuse: '1sat-ft' }
  }
  const tip = decodeListedBsv21Tip({
    outpoint: args.outpoint,
    satoshis: args.satoshis ?? 1,
    tags: args.tags,
    customInstructions: args.customInstructions,
    lockingScript: args.lockingScriptHex,
  })
  if (!tip) return { assetType: 'ordinal' }
  const amt = Number(tip.amt)
  return {
    assetType: 'bsv21',
    tokenId: tip.tokenId,
    amt: Number.isSafeInteger(amt) && amt > 0 ? amt : undefined,
  }
}

/**
 * Held-item remittance for a market listing or settlement.
 * Fungibles: basket `bsv21`, 163 amt/id copied from the 162 tip.
 * Collectables: basket `1sat`. Never emits 1sat-ft.
 */
export function buildMarketHeldRemittance(args: {
  assetType: MarketAssetType
  origin: string
  amt?: number
  name?: string
  icon?: string
  provenance?: ProvenanceV2
  extraTags?: string[]
}): { basket: string; tags: string[]; customInstructions: string } {
  if (args.assetType === 'bsv21') {
    if (args.amt == null || !(args.amt > 0)) {
      throw new MarketListingError(
        'MARKET_ASSET_UNSUPPORTED',
        'BSV-21 listing requires a 162 amount.',
      )
    }
    const remit = buildBsv21SendRemittance({
      tokenId: args.origin,
      amt: BigInt(args.amt),
      icon: args.icon,
    })
    assertNoOnesatFtRemittance(remit.customInstructions)
    return {
      basket: remit.basket,
      tags: [...remit.tags, ...(args.extraTags ?? [])],
      customInstructions: remit.customInstructions,
    }
  }
  const customInstructions = buildCollectableCustomInstructions({
    origin: args.origin,
    name: args.name?.trim() || 'Market item',
    provenance: args.provenance,
  })
  assertNoOnesatFtRemittance(customInstructions)
  return {
    basket: '1sat',
    tags: [
      'ordinal',
      ...(args.extraTags ?? []),
      `origin:${args.origin.replace('_', '.')}`,
    ],
    customInstructions,
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
    bare === 'market-v2.handcash.io' ||
    bare === 'handcash-market-v2.pages.dev' ||
    bare === 'brc-cloud.bcryderman.workers.dev'
  )
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


function tagPrefixValue(tags: string[] | undefined, prefix: string): string | undefined {
  if (!tags) return undefined
  const needle = prefix.toLowerCase()
  for (const tag of tags) {
    if (tag.toLowerCase().startsWith(needle)) {
      const value = tag.slice(prefix.length).trim()
      if (value) return value
    }
  }
  return undefined
}

/**
 * Origin a 1sat listing binds. Inventory eligibility uses the durable BRC-150
 * verdict; listing must use that same origin, not a remittance claim. Minted
 * and imported tips often have no customInstructions.origin at all.
 */
export function resolveOrdinalListingOrigin(args: {
  outpoint: string
  customOrigin?: unknown
  tags?: string[]
}): string {
  const verdict = getProvenVerdict(args.outpoint)
  return normalizeOriginOutpoint(
    verdict?.origin ?? args.customOrigin ?? tagPrefixValue(args.tags, 'origin:'),
  )
}

function normalizeOutpoint(value: unknown): string {
  const underscored = toUnderscoreOutpoint(String(value ?? ''))
  if (!/^[0-9a-f]{64}_(0|[1-9]\d*)$/.test(underscored)) {
    throw new Error(
      'Listing outpoint must be a transaction id and output index'
    )
  }
  return underscored
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

/**
 * First proof whose canonical JSON fits the overlay's budget, in order of
 * preference. Candidates may be null when they could not be assembled.
 */
export function choosePublishableProvenance(
  candidates: Array<ProvenanceV2 | null>,
): ProvenanceV2 | null {
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      if (hashMarketProvenance(candidate).size <= MARKET_MAX_PROVENANCE_JSON_BYTES) {
        return candidate
      }
    } catch {
      // Not serializable as canonical JSON — try the next candidate.
    }
  }
  return null
}

export function hashMarketProvenance(
  provenance: ProvenanceV2 | Bsv21ListingProof,
): {
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

export type MarketListingPreview = {
  itemOutpoint?: string
  tokenId?: string
  itemName?: string
  itemImageUrl?: string
  previewKind?: 'token' | 'collectable'
}

/** Display hints for permission prompts — market sends full listing JSON, not just advert fields. */
export function marketListingPreviewFromArgs(args: unknown): MarketListingPreview | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null
  const body = args as Record<string, unknown>
  const listing =
    body.listing && typeof body.listing === 'object' && !Array.isArray(body.listing)
      ? (body.listing as Record<string, unknown>)
      : null
  if (!listing) return null
  const outpoint =
    typeof listing.outpoint === 'string' ? listing.outpoint.trim().toLowerCase() : ''
  if (!outpoint) return null
  const isToken = listing.assetType === 'bsv21'
  const origin =
    typeof listing.origin === 'string' ? listing.origin.trim().toLowerCase() : ''
  const sym = typeof listing.sym === 'string' ? listing.sym.trim() : ''
  const name = typeof listing.name === 'string' ? listing.name.trim() : ''
  const contentUrl =
    typeof listing.contentUrl === 'string' && listing.contentUrl.trim()
      ? listing.contentUrl.trim()
      : undefined
  return {
    itemOutpoint: outpoint.replace(/_(\d+)$/, '.$1'),
    ...(isToken && origin ? { tokenId: origin } : {}),
    itemName: sym || name || (isToken ? 'Token' : 'Collectable'),
    ...(contentUrl ? { itemImageUrl: contentUrl } : {}),
    previewKind: isToken ? 'token' : 'collectable',
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
    Math.abs(now - intent.createdAt) <= 15 * 60_000 &&
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
    Math.abs(now - receipt.settledAt) <= 15 * 60_000 &&
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

/** All persisted listing authorizations (newest per key wins on read). */
export function listMarketListingAuthorizations(): MarketListingAuthorization[] {
  return readAuthorizations()
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
    readAuthorizations().find((item) => item.reservationSaleId === saleId) ?? null
  )
}

export function markMarketSettlementProgress(args: {
  saleId: string
  settlementTxid: string
  proceedsInternalized?: boolean
  itemRetired?: boolean
}): MarketListingAuthorization {
  const current = findMarketListingAuthorizationBySaleId(args.saleId)
  if (!current) {
    throw new MarketListingError('LISTING_NOT_AUTHORIZED', 'Sale reservation not found.')
  }
  if (
    current.settlementTxid &&
    current.settlementTxid !== args.settlementTxid.toLowerCase()
  ) {
    throw new MarketListingError(
      'SETTLEMENT_TX_MISMATCH',
      'A different settlement transaction is already recorded.'
    )
  }
  const next: MarketListingAuthorization = {
    ...current,
    settlementTxid: args.settlementTxid.toLowerCase(),
    proceedsInternalized:
      current.proceedsInternalized || args.proceedsInternalized || undefined,
    itemRetired: current.itemRetired || args.itemRetired || undefined,
    updatedAt: Date.now(),
  }
  saveAuthorization(next)
  return next
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

async function loadListedOutput(
  outpoint: string,
  preferredAsset?: 'ordinal' | 'bsv21',
) {
  const active = getActiveWallet()
  if (!active) throw new MarketListingError('WALLET_LOCKED', 'Wallet locked')
  const query = {
    limit: 10_000,
    includeTags: true,
    includeCustomInstructions: true,
    include: 'locking scripts' as const,
    seekPermission: false,
  }
  type Listed = NonNullable<Awaited<ReturnType<typeof active.wallet.listOutputs>>['outputs']>[number]
  const baskets: Array<'1sat' | 'bsv21'> =
    preferredAsset === 'bsv21'
      ? ['bsv21', '1sat']
      : preferredAsset === 'ordinal'
        ? ['1sat', 'bsv21']
        : ['1sat', 'bsv21']
  const findInBaskets = async (): Promise<Listed | undefined> => {
    for (const basket of baskets) {
      const listed = await active.wallet.listOutputs({ ...query, basket })
      const hit = (listed.outputs ?? []).find(
        (candidate) => normalizeOutpoint(candidate.outpoint) === outpoint,
      )
      if (hit) return hit
    }
    return undefined
  }
  let output = await findInBaskets()
  if (!output) {
    // Prior Arcade hard-reject can leave the tip spendable=false while still on
    // chain. Revive once, then rescan — avoid probing explorers on every list.
    try {
      const { restoreUnspentAssetOutpoint } = await import('./staleOutputRelease')
      if (await restoreUnspentAssetOutpoint(active, outpoint.replace('_', '.'))) {
        output = await findInBaskets()
      }
    } catch {
      /* restore is best-effort */
    }
  }
  if (!output) {
    throw new MarketListingError(
      'ITEM_NOT_HELD',
      'The listed item is no longer held by this wallet.'
    )
  }
  // Basket rows lag the chain. A tip still listed locally but spent elsewhere
  // is what produces "Already spent" on list after a friend-send / prior list.
  const live = await tipStillUnspentOnChain(active, outpoint)
  if (live === false) {
    await retireSpentListingTip(active, outpoint)
    throw new MarketListingError(
      'ITEM_NOT_HELD',
      'This item is already spent on chain. It was removed from Collectables.',
    )
  }
  if ((output.satoshis ?? 1) !== 1) {
    throw new MarketListingError(
      'ITEM_NOT_ORDINAL',
      'The listed output is not a one-satoshi item.'
    )
  }
  const lockingScriptHex =
    typeof output.lockingScript === 'string' ? output.lockingScript : undefined
  const classified = classifyMarketListingAsset({
    outpoint,
    satoshis: output.satoshis,
    tags: output.tags,
    customInstructions: output.customInstructions,
    lockingScriptHex,
  })
  if (classified.refuse === '1sat-ft') {
    throw new MarketListingError(
      'MARKET_ASSET_UNSUPPORTED',
      '1sat-ft leftovers are not listable.',
    )
  }
  return {
    active,
    output,
    assetType: classified.assetType,
    tokenId: classified.tokenId,
    amt: classified.amt,
  }
}

/**
 * When listAmt is not the covering tip's 162 amt, split/consolidate first so
 * the listed UTXO lock equals listAmt (remainder is 162 change to the seller).
 * The listing tx then lists that exact tip: advert.amt === lock amt === 176
 * proof.amt. Never advertise a partial amt against a larger covering lock.
 */
async function splitBsv21CoverToExactAmt(args: {
  active: ActiveWallet
  origin: string
  requested: number
  covers: Array<{ outpoint: string; amt: bigint; lockingScript?: string }>
  icon?: string
  sym?: string
}): Promise<{
  outpoint: string
  lockingScript: string
  beef: Awaited<ReturnType<typeof getBeefForTxidCached>>
}> {
  const requested = BigInt(args.requested)
  const coverSum = args.covers.reduce((sum, t) => sum + t.amt, 0n)
  if (coverSum < requested) {
    throw new Error('Not enough units available to list that amount.')
  }
  const changeAmt = coverSum - requested
  const listedLock = buildBsv21ValueLock({
    tokenId: args.origin,
    amount: requested,
    address: args.active.address,
  })
  const key = PrivateKey.fromHex(args.active.rootKeyHex)
  const vin0 = args.covers[0]
  if (!vin0) throw new Error('Not enough units available to list that amount.')
  const itemTxid = vin0.outpoint.slice(0, 64)
  const splitBeef = await getBeefForTxidCached(args.active, itemTxid, { needProof: true, allowUnprovenRawTx: true })
  for (const extra of args.covers.slice(1)) {
    const extraTxid = extra.outpoint.slice(0, 64)
    if (extraTxid === itemTxid) continue
    try {
      const extraBeef = await getBeefForTxidCached(args.active, extraTxid, {
        needProof: true,
        allowUnprovenRawTx: true,
      })
      splitBeef.mergeBeef(extraBeef.toBinary())
    } catch {
      // Overlay conservation still sees the extra input; BEEF hydrate is best-effort.
    }
  }
  const created = await args.active.wallet.createAction({
    description: 'Split BSV-21 cover for market list',
    labels: ['market-v3', 'bsv21-split'],
    inputBEEF: splitBeef.toBinary(),
    inputs: args.covers.map((tip, i) => ({
      outpoint: tip.outpoint.replace('_', '.'),
      inputDescription: i === 0 ? 'BSV-21 list cover' : 'BSV-21 list extra cover',
      unlockingScriptLength: 108,
    })),
    outputs: [
      {
        lockingScript: listedLock,
        satoshis: 1,
        outputDescription: 'BSV-21 list amount',
        ...buildBsv21SendRemittance({
          tokenId: args.origin,
          amt: requested,
          icon: args.icon,
          ...(args.sym ? { sym: args.sym } : {}),
        }),
      },
      ...(changeAmt > 0n
        ? [
            {
              lockingScript: buildBsv21ValueLock({
                tokenId: args.origin,
                amount: changeAmt,
                address: args.active.address,
              }),
              satoshis: 1,
              outputDescription: 'BSV-21 listing change',
              ...buildBsv21SendRemittance({
                tokenId: args.origin,
                amt: changeAmt,
                icon: args.icon,
                ...(args.sym ? { sym: args.sym } : {}),
              }),
            },
          ]
        : []),
    ],
    options: {
      randomizeOutputs: false,
      signAndProcess: false,
      trustSelf: 'known',
    },
  })
  const signable = created.signableTransaction
  if (!signable) throw new Error('BSV-21 list split did not return a signable action')
  const reference = signable.reference
  try {
    const beef = Beef.fromBinary(signable.tx)
    const vin0Vout = Number(vin0.outpoint.split('_')[1])
    const tx = beef.txs.find((entry) =>
      entry.tx?.inputs.some(
        (input) =>
          String(input.sourceTXID).toLowerCase() === itemTxid &&
          input.sourceOutputIndex === vin0Vout,
      ),
    )?.tx
    if (!tx) throw new Error('BSV-21 list split is missing cover input')
    const selectedPoints = new Set(args.covers.map((tip) => tip.outpoint))
    if (
      String(tx.inputs[0]?.sourceTXID).toLowerCase() !== itemTxid ||
      tx.inputs[0]?.sourceOutputIndex !== vin0Vout ||
      tx.outputs[0]?.lockingScript?.toHex() !== listedLock
    ) {
      throw new MarketListingError(
        'MARKET_LISTING_SHAPE_MISMATCH',
        'Wallet did not preserve BSV-21 list-split output ordering.',
      )
    }
    const spends: Record<number, { unlockingScript: string }> = {}
    for (let i = 0; i < tx.inputs.length; i += 1) {
      const vin = tx.inputs[i]!
      const src = `${String(vin.sourceTXID).toLowerCase()}_${vin.sourceOutputIndex}`
      if (i !== 0 && !selectedPoints.has(src)) continue
      vin.sourceTransaction ??=
        splitBeef.findTxid(String(vin.sourceTXID))?.tx ??
        beef.findTxid(String(vin.sourceTXID))?.tx
      const sourceOut = vin.sourceTransaction?.outputs[vin.sourceOutputIndex]
      const satoshis = sourceOut?.satoshis
      const lockingScript = sourceOut?.lockingScript
      if (typeof satoshis !== 'number' || !lockingScript) {
        throw new Error('List-split input is missing its source locking script')
      }
      vin.unlockingScriptTemplate = new P2PKH().unlock(
        key,
        'all',
        false,
        satoshis,
        lockingScript,
      )
    }
    await tx.sign()
    for (let i = 0; i < tx.inputs.length; i += 1) {
      const unlockingScript = tx.inputs[i]?.unlockingScript?.toHex()
      if (!unlockingScript) {
        if (i === 0) throw new Error('BSV-21 list-split signature missing')
        continue
      }
      spends[i] = { unlockingScript }
    }
    if (!spends[0]) throw new Error('BSV-21 list-split signature missing')
    const signed = await args.active.wallet.signAction({
      reference,
      spends,
      options: { acceptDelayedBroadcast: false },
    })
    const txid = signed.txid?.toLowerCase() ?? ''
    if (!/^[0-9a-f]{64}$/.test(txid)) {
      throw new MarketListingError(
        'MARKET_LISTING_BROADCAST_UNKNOWN',
        'BSV-21 list split was signed but did not return a transaction.',
      )
    }
    rememberGhostTx(txid)
    return {
      outpoint: `${txid}_0`,
      lockingScript: listedLock,
      beef: signed.tx
        ? Beef.fromBinary(Array.from(signed.tx))
        : splitBeef,
    }
  } catch (err) {
    await args.active.wallet.abortAction({ reference }).catch(() => {})
    throw err
  }
}

/**
 * Which input a miner spend-conflict actually belongs to.
 *
 * "Already spent" on a listing is read by the seller as an accusation against the
 * item. Usually it is a dead funding coin: the tip is still live and sendable.
 */
export type MarketSpendConflict =
  | 'item-spent'
  | 'funding-spent'
  | 'none-proven'
  | 'not-checked'

/**
 * Abort a listing/cancel noSend that Arcade never accepted, and revive the tip
 * so the next list does not throw ITEM_NOT_HELD.
 */
async function abortUnsentMarketAction(args: {
  active: ActiveWallet
  reference: string | null
  chart: {
    getSnapshot: () => Parameters<typeof mayAbortMarketListing>[0]
    send: (event: { type: 'ABORTED'; error: string } | { type: 'FAIL'; error: string }) => void
  }
  tipOutpoint: string
  reason: string
  /** Signed listing txid when Arcade rejected after signAction. */
  signedTxid?: string | null
  atomic?: number[] | null
}): Promise<MarketSpendConflict> {
  const snap = args.chart.getSnapshot()
  if (!mayAbortMarketListing(snap)) {
    args.chart.send({ type: 'FAIL', error: args.reason })
    return 'not-checked'
  }
  if (args.reference) {
    await args.active.wallet.abortAction({ reference: args.reference }).catch(() => {})
  }
  args.chart.send({ type: 'ABORTED', error: args.reason })
  if (isAlreadySpentListingFailure(args.reason)) {
    return retireProvenSpentListingInputs({
      active: args.active,
      tipOutpoint: args.tipOutpoint,
      signedTxid: args.signedTxid ?? null,
      atomic: args.atomic ?? null,
    })
  }
  try {
    const { restoreUnspentAssetOutpoint } = await import('./staleOutputRelease')
    await restoreUnspentAssetOutpoint(
      args.active,
      args.tipOutpoint.replace('_', '.'),
    )
  } catch (err) {
    console.warn(
      '[market] tip restore after unsent abort skipped',
      err instanceof Error ? err.message : String(err),
    )
  }
  return 'not-checked'
}

async function prepareMarketListingSpend(active: ActiveWallet): Promise<void> {
  const { releaseStuckNosends, abortReservedActionBatches } = await import(
    './actionReview'
  )
  await releaseStuckNosends(active)
  await abortReservedActionBatches(active, { budgetMs: 1_500 })
}

/** Arcade/miner answers that mean the tip (or a funding input) is already gone. */
export function isAlreadySpentListingFailure(reason: string): boolean {
  return (
    /already spent/i.test(reason) ||
    /ARCADE_HARD_REJECT/i.test(reason) ||
    /missing.?inputs/i.test(reason) ||
    /double.?spend/i.test(reason)
  )
}

/**
 * True when a live UTXO service still sees this tip. Unknown/offline does not
 * fail closed here — createAction will surface a real spend conflict.
 */
async function tipStillUnspentOnChain(
  active: ActiveWallet,
  outpoint: string,
): Promise<boolean | null> {
  const { parseOutpoint, spentStatusOfOutpoint } = await import('./legacyScan')
  const parsed = parseOutpoint(outpoint.replace('_', '.'))
  if (!parsed) return null
  const isUtxo = active.services?.isUtxo
  if (typeof isUtxo === 'function') {
    try {
      const result = await isUtxo({ txid: parsed.txid, vout: parsed.vout } as never)
      if (result === true) return true
      if (
        result &&
        typeof result === 'object' &&
        (result as { isUtxo?: unknown }).isUtxo === true
      ) {
        return true
      }
      if (result === false) return false
      if (
        result &&
        typeof result === 'object' &&
        (result as { isUtxo?: unknown }).isUtxo === false
      ) {
        return false
      }
    } catch {
      /* fall through */
    }
  }
  const status = await spentStatusOfOutpoint(outpoint, active.chain).catch(
    () => 'unknown' as const,
  )
  if (status === 'unspent') return true
  if (status === 'spent') return false
  return null
}

/**
 * After Arcade Already-spent: drop only inputs proven spent on chain.
 * Fee ghosts must leave inventory; a still-live tip must not (friend-send
 * can still move it). Unknown indexer silence leaves rows alone.
 */
async function retireProvenSpentListingInputs(args: {
  active: ActiveWallet
  tipOutpoint: string
  signedTxid: string | null
  atomic: number[] | null
}): Promise<MarketSpendConflict> {
  const tipKey = normalizeOutpoint(args.tipOutpoint)
  const candidates = new Set<string>([tipKey])
  if (args.signedTxid && args.atomic?.length) {
    try {
      const { inputOutpointsFromAtomicBeef } = await import('./txOutpoints')
      for (const op of inputOutpointsFromAtomicBeef(
        args.atomic,
        args.signedTxid,
      )) {
        try {
          candidates.add(normalizeOutpoint(op))
        } catch {
          /* skip malformed */
        }
      }
    } catch {
      /* atomic parse optional */
    }
  }
  const spent: string[] = []
  for (const op of candidates) {
    const live = await tipStillUnspentOnChain(args.active, op)
    if (live === false) spent.push(op)
  }
  if (spent.length === 0) {
    console.info(
      `[market] Already spent but no input proven spent on chain — tip ${tipKey.slice(0, 18)}… kept`,
    )
    try {
      const { restoreUnspentAssetOutpoint } = await import('./staleOutputRelease')
      await restoreUnspentAssetOutpoint(args.active, tipKey.replace('_', '.'))
    } catch {
      /* best-effort */
    }
    return 'none-proven'
  }
  const feeSpent = spent.filter((op) => op !== tipKey)
  if (feeSpent.length > 0) {
    try {
      const { hideSpentOutpoints } = await import('./staleOutputRelease')
      await hideSpentOutpoints(feeSpent, '')
      console.info(
        `[market] listing funding conflict — hid ${feeSpent.length} funding coin(s) proven spent on chain`,
      )
    } catch {
      /* best-effort */
    }
  }
  if (spent.includes(tipKey)) {
    await dropSpentListingTip(args.active, tipKey)
    return 'item-spent'
  }
  try {
    const { restoreUnspentAssetOutpoint } = await import('./staleOutputRelease')
    await restoreUnspentAssetOutpoint(args.active, tipKey.replace('_', '.'))
  } catch {
    /* best-effort */
  }
  return feeSpent.length > 0 ? 'funding-spent' : 'none-proven'
}

/**
 * Drop a tip proven spent on chain so Collect stops offering it.
 * Call only after {@link tipStillUnspentOnChain} returned false.
 */
async function dropSpentListingTip(
  active: ActiveWallet,
  tipOutpoint: string,
): Promise<void> {
  try {
    const { hideSpentOutpoints } = await import('./staleOutputRelease')
    await hideSpentOutpoints([tipOutpoint], '')
  } catch {
    /* best-effort */
  }
  try {
    const { hideCollectablesAfterSpend } = await import('./collectables')
    hideCollectablesAfterSpend([tipOutpoint], 'already-spent')
  } catch {
    /* best-effort */
  }
  try {
    await active.wallet.relinquishOutput({
      basket: '1sat',
      output: tipOutpoint.replace('_', '.'),
    })
  } catch {
    /* already gone from basket */
  }
  try {
    await active.wallet.relinquishOutput({
      basket: 'bsv21',
      output: tipOutpoint.replace('_', '.'),
    })
  } catch {
    /* not a 162 tip */
  }
  console.info(
    `[market] retired spent listing tip ${tipOutpoint.slice(0, 18)}… — inventory dropped`,
  )
}

/**
 * Drop a tip that Arcade/chain already spent so Collect stops offering it.
 * Fee-input conflicts leave the tip live — those must not be retired.
 */
async function retireSpentListingTip(
  active: ActiveWallet,
  tipOutpoint: string,
): Promise<void> {
  const stillLive = await tipStillUnspentOnChain(active, tipOutpoint)
  if (stillLive === true) {
    try {
      const { restoreUnspentAssetOutpoint } = await import('./staleOutputRelease')
      await restoreUnspentAssetOutpoint(active, tipOutpoint.replace('_', '.'))
    } catch {
      /* best-effort */
    }
    return
  }
  if (stillLive === null) {
    // Unknown — do not drop a tip that may still be live (fee-input Already spent).
    console.info(
      `[market] tip spend status unknown for ${tipOutpoint.slice(0, 18)}…; leaving inventory`,
    )
    return
  }
  await dropSpentListingTip(active, tipOutpoint)
}

export async function createMarketListingAdvert(
  args: CreateMarketListingArgs
): Promise<MarketListingPostPayload> {
  if ((args as { assetType?: string }).assetType === '1sat-ft') {
    throw new MarketListingError(
      'MARKET_ASSET_UNSUPPORTED',
      'Market overlay v1 supports 1sat collectables and BSV-21 tokens only.',
    )
  }
  // Serialize with consolidate / other spends so fee inputs are not raced, and
  // so a prior failed list's reserved tip can be aborted before we scan.
  return runExclusiveSpend(
    () => createMarketListingAdvertExclusive(args),
    undefined,
    { promote: false },
  )
}

async function createMarketListingAdvertExclusive(
  args: CreateMarketListingArgs
): Promise<MarketListingPostPayload> {
  const outpoint = normalizeOutpoint(args.outpoint)
  let listingOutpoint = outpoint
  let itemTxid = listingOutpoint.slice(0, 64)
  const extraCoverTips: Array<{
    outpoint: string
    amt: bigint
    lockingScript?: string
  }> = []
  /** Signed BEEF of a just-broadcast BSV-21 cover split — never re-fetched. */
  let splitListingBeef: Awaited<ReturnType<typeof getBeefForTxidCached>> | undefined
  const activeEarly = getActiveWallet()
  if (!activeEarly) throw new MarketListingError('WALLET_LOCKED', 'Wallet locked')
  await prepareMarketListingSpend(activeEarly)
  const preferred =
    args.assetType === 'bsv21' || args.assetType === 'ordinal'
      ? args.assetType
      : undefined
  const { active, output, assetType, tokenId, amt: classifiedAmt } =
    await loadListedOutput(outpoint, preferred)
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
  const lockingScriptHex =
    typeof output.lockingScript === 'string' ? output.lockingScript : undefined
  const lockTip = lockingScriptHex
    ? decodeListedBsv21Tip({
        outpoint,
        satoshis: output.satoshis ?? 1,
        tags: output.tags,
        customInstructions: output.customInstructions,
        lockingScript: lockingScriptHex,
      })
    : null
  const lockIsBsv21 = Boolean(
    assetType === 'bsv21' ||
      lockTip ||
      (lockingScriptHex && decodeBsv21Binary(lockingScriptHex)),
  )
  const askedBsv21 = args.assetType === 'bsv21'
  const listedAsset: MarketAssetType =
    askedBsv21 || lockIsBsv21 ? 'bsv21' : 'ordinal'
  if (askedBsv21 && !lockIsBsv21) {
    throw new MarketListingError(
      'MARKET_ASSET_UNSUPPORTED',
      'BSV-21 listing requires a 162 value lock.',
    )
  }
  const origin =
    listedAsset === 'bsv21'
      ? normalizeOriginOutpoint(tokenId || lockTip?.tokenId || custom.origin)
      : resolveOrdinalListingOrigin({
          outpoint,
          customOrigin: custom.origin,
          tags: output.tags,
        })
  let provenance: ProvenanceV2 | Bsv21ListingProof
  let amt = listedAsset === 'bsv21' ? classifiedAmt : undefined
  let tipAmt = classifiedAmt
  if (listedAsset === 'bsv21') {
    if (!lockingScriptHex) {
      throw new MarketListingError(
        'MARKET_ASSET_UNSUPPORTED',
        'BSV-21 listing requires a 162 value lock.',
      )
    }
    let beef: Awaited<ReturnType<typeof getBeefForTxidCached>> | undefined
    try {
      beef = await getBeefForTxidCached(active, itemTxid, { needProof: true, allowUnprovenRawTx: true })
    } catch {
      beef = undefined
    }
    provenance = buildBsv21ListingProof({
      outpoint: listingOutpoint,
      lockingScriptHex,
      customInstructions: output.customInstructions,
      ...(beef ? { beef } : {}),
    })
    let provenAmt = Number(provenance.amt)
    if (!Number.isSafeInteger(provenAmt) || provenAmt <= 0) {
      throw new MarketListingError(
        'MARKET_ASSET_UNSUPPORTED',
        'BSV-21 listing requires a 162 amount.',
      )
    }
    tipAmt = provenAmt
    const requested = args.listAmt == null ? provenAmt : Math.trunc(Number(args.listAmt))
    if (!Number.isSafeInteger(requested) || requested < 1) {
      throw new Error('List at least 1 unit')
    }
    if (requested > provenAmt) {
      const tips = (await listBsv21BinaryTips(active)).filter((t) => t.tokenId === origin)
      const plannedTips = tips.map((t) => ({
        outpoint: t.outpoint,
        tokenId: t.tokenId,
        amt: BigInt(String(t.amt).replace(/\D/g, '') || '0'),
        lockingScript: t.lockingScript,
      }))
      if (!plannedTips.some((t) => normalizeOutpoint(t.outpoint) === listingOutpoint)) {
        plannedTips.push({
          outpoint: listingOutpoint,
          tokenId: origin,
          amt: BigInt(provenAmt),
          lockingScript: lockingScriptHex,
        })
      }
      let plan
      try {
        plan = planBsv21Send({
          tokenId: origin,
          amount: BigInt(requested),
          tips: plannedTips,
        })
      } catch {
        throw new Error('Not enough units available to list that amount.')
      }
      const selected = [...plan.selected]
      const origIdx = selected.findIndex(
        (t) => normalizeOutpoint(t.outpoint) === listingOutpoint,
      )
      if (origIdx > 0) {
        const [orig] = selected.splice(origIdx, 1)
        selected.unshift(orig!)
      } else if (origIdx < 0) {
        const vin0 = selected[0]
        if (!vin0?.lockingScript) {
          throw new Error('Not enough units available to list that amount.')
        }
        listingOutpoint = normalizeOutpoint(vin0.outpoint)
        itemTxid = listingOutpoint.slice(0, 64)
        provenAmt = Number(vin0.amt)
        let vin0Beef: Awaited<ReturnType<typeof getBeefForTxidCached>> | undefined
        try {
          vin0Beef = await getBeefForTxidCached(active, itemTxid, { needProof: true, allowUnprovenRawTx: true })
        } catch {
          vin0Beef = undefined
        }
        provenance = buildBsv21ListingProof({
          outpoint: listingOutpoint,
          lockingScriptHex: vin0.lockingScript,
          ...(vin0Beef ? { beef: vin0Beef } : {}),
        })
      }
      extraCoverTips.push(
        ...selected.slice(1).map((t) => ({
          outpoint: normalizeOutpoint(t.outpoint),
          amt: t.amt,
          lockingScript: t.lockingScript,
        })),
      )
      tipAmt = Number(selected.reduce((sum, t) => sum + t.amt, 0n))
    }
    if (requested !== provenAmt || extraCoverTips.length > 0) {
      const split = await splitBsv21CoverToExactAmt({
        active,
        origin,
        requested,
        covers: [
          {
            outpoint: listingOutpoint,
            amt: BigInt(provenAmt),
            lockingScript: lockingScriptHex,
          },
          ...extraCoverTips,
        ],
        icon: lockTip?.icon,
        ...(lockTip?.sym ? { sym: lockTip.sym } : {}),
      })
      listingOutpoint = split.outpoint
      itemTxid = listingOutpoint.slice(0, 64)
      // The split tx is seconds old. Asking an indexer to prove it costs the
      // full fetch/WoC/raw ladder and can never succeed until it is mined — we
      // already hold the signed BEEF, so carry it into the listing.
      splitListingBeef = split.beef
      extraCoverTips.length = 0
      provenAmt = requested
      tipAmt = requested
      provenance = buildBsv21ListingProof({
        outpoint: listingOutpoint,
        lockingScriptHex: split.lockingScript,
        beef: split.beef,
      })
    }
    amt = requested
  } else {
    // Inventory paints "verified" from durable provenCache; remittance is often
    // absent from customInstructions (internalize 1k cap). Rebuild the same way
    // collectable send does — trust the verdict, replay its path, allow a
    // publish-sized package the overlay size-gates separately.
    const remittanceProvenance =
      tryParseProvenanceFromCi(output.customInstructions) ??
      getRememberedProvenanceRemittance(outpoint)
    const verdict = getProvenVerdict(outpoint)
    const trustProven = verdict?.tier === 'brc150'
    const built = await tryBuildProvenanceV2({
      tipOutpoint: outpoint,
      origin,
      wallet: active,
      priorProvenance: remittanceProvenance ?? custom.provenance,
      allowLineageHydrate: true,
      trustProven,
      allowOversized: true,
      ...(verdict?.path?.length ? { path: verdict.path } : {}),
    })
    const seed = built ?? remittanceProvenance
    if (!seed) {
      throw new MarketListingError(
        'ITEM_ORIGIN_UNPROVEN',
        trustProven
          ? 'This item is verified locally but a publishable BRC-150 package could not be rebuilt. Refresh Collectables and try again.'
          : 'A complete BRC-150 proof could not be built for this item.',
      )
    }
    const outstanding = provenanceMissingPathBodies(seed)
    const complete =
      outstanding && outstanding.length <= MARKET_OVERLAY_HYDRATE_MAX_TXS
        ? null
        : await completeProvenanceForPublish({
            provenance: seed,
            getBeef: (txid) => getBeefForTxidCached(active, txid, { needProof: true, allowUnprovenRawTx: true }),
          })
    const chosen = choosePublishableProvenance([complete, seed])
    if (!chosen) {
      throw new MarketListingError(
        'ITEM_PROVENANCE_TOO_LARGE',
        'This item’s BRC-150 proof is too large for the market overlay.'
      )
    }
    const verified = await verifyProvenanceV2Async(chosen, outpoint, {
      enforceBudget: false,
      getBeef: (txid) => getBeefForTxidCached(active, txid, { needProof: true, allowUnprovenRawTx: true }),
    })
    if (!verified.proven) {
      throw new MarketListingError(
        'ITEM_ORIGIN_UNPROVEN',
        `BRC-150 verification failed: ${verified.reason ?? 'unknown reason'}`
      )
    }
    provenance = chosen
  }
  const digest = hashMarketProvenance(provenance)
  const nonce = randomNonce()
  const exactFeeSats = Math.floor(
    (priceSats * MARKET_FEE_BASIS_POINTS) / 10_000
  )
  const fields = normalizeMarketOfferFields({
    sellerIdentityKey: active.identityKey,
    payTo: active.address,
    grossPriceSats: priceSats,
    feeIdentityKey: MARKET_FEE_IDENTITY_KEY,
    feePayTo: MARKET_FEE_PAY_TO_ADDRESS,
    feeBasisPoints: MARKET_FEE_BASIS_POINTS,
    exactFeeSats,
    provenanceHash: digest.hash,
    provenanceSize: digest.size,
    provenanceVersion: MARKET_PROVENANCE_VERSION,
    expiresAt,
    nonce,
    messagebox: publicMessageboxBase(args.messagebox),
  })
  const offerKey = PrivateKey.fromHex(active.rootKeyHex)
  const offerLockingScript = encodeMarketOffer(fields, offerKey)
  const itemLockingScript =
    listedAsset === 'bsv21'
      ? buildBsv21ValueLock({
          tokenId: origin,
          amount: BigInt(amt!),
          address: active.address,
        })
      : new P2PKH().lock(active.address).toHex()
  const path = chooseMarketListingPath({
    itemOutpoint: listingOutpoint,
    satoshis: output.satoshis ?? 0,
    ordinal:
      listedAsset === 'bsv21' ||
      (output.tags ?? []).some((tag) => tag.toLowerCase() === 'ordinal'),
    provenanceProven: true,
    termsValid: true,
  })
  if (path.path === 'refuse') {
    throw new MarketListingError('MARKET_LISTING_REFUSED', path.reason)
  }
  const chart = createActor(marketListingMachine).start()
  chart.send({ type: 'LIST', path })
  const listingBeef =
    splitListingBeef ??
    (await getBeefForTxidCached(active, itemTxid, { needProof: true, allowUnprovenRawTx: true }))
  if (listedAsset === 'bsv21' && lockTip?.icon) {
    await mergeIconTxIntoBeef(active, listingBeef, lockTip.icon)
  }
  for (const extra of extraCoverTips) {
    const extraTxid = extra.outpoint.slice(0, 64)
    if (extraTxid === itemTxid) continue
    try {
      const extraBeef = await getBeefForTxidCached(active, extraTxid, { needProof: true, allowUnprovenRawTx: true })
      listingBeef.mergeBeef(extraBeef.toBinary())
    } catch {
      // Overlay conservation still sees the extra input; BEEF hydrate is best-effort.
    }
  }
  const inputBEEF = listingBeef.toBinary()
  let reference: string | null = null
  let signedTxid: string | null = null
  let signedAtomic: number[] | null = null
  try {
    const created = await active.wallet.createAction({
      description: 'Create 1Sat market offer',
      labels: ['market-v3', 'brc48', 'brc147', 'brc150', 'brc159'],
      inputBEEF,
      inputs: [
        {
          outpoint: listingOutpoint.replace('_', '.'),
          inputDescription: 'Market item input zero',
          unlockingScriptLength: 108,
        },
        ...extraCoverTips.map((tip) => ({
          outpoint: tip.outpoint.replace('_', '.'),
          inputDescription: 'BSV-21 listing cover',
          unlockingScriptLength: 108,
        })),
      ],
      outputs: [
        {
          lockingScript: itemLockingScript,
          satoshis: 1,
          outputDescription: 'Held market item',
          ...buildMarketHeldRemittance({
            assetType: listedAsset,
            origin,
            amt,
            icon: listedAsset === 'bsv21' ? lockTip?.icon : undefined,
            name:
              typeof custom.name === 'string' && custom.name.trim()
                ? custom.name.trim()
                : undefined,
            ...(listedAsset === 'ordinal' && 'origin' in provenance
              ? { provenance: provenance }
              : {}),
            extraTags: ['market-held'],
          }),
        },
        {
          lockingScript: offerLockingScript,
          satoshis: MARKET_OFFER_DEPOSIT_SATS,
          outputDescription: 'BRC-48 market offer',
          basket: 'market-offers',
          tags: ['brc48', `nonce:${nonce}`, `origin:${origin.replace('_', '.')}`],
          customInstructions: JSON.stringify({ fields }),
        },
        ...(listedAsset === 'bsv21' && tipAmt != null && amt != null && tipAmt > amt
          ? [
              {
                lockingScript: buildBsv21ValueLock({
                  tokenId: origin,
                  amount: BigInt(tipAmt - amt),
                  address: active.address,
                }),
                satoshis: 1,
                outputDescription: 'BSV-21 listing change',
                ...buildBsv21SendRemittance({
                  tokenId: origin,
                  amt: BigInt(tipAmt - amt),
                  icon: lockTip?.icon,
                  ...(lockTip?.sym ? { sym: lockTip.sym } : {}),
                }),
              },
            ]
          : []),
      ],
      options: {
        randomizeOutputs: false,
        signAndProcess: false,
        noSend: true,
        trustSelf: 'known',
      },
    })
    const signable = created.signableTransaction
    if (!signable) throw new Error('Market listing did not return a signable action')
    reference = signable.reference
    chart.send({ type: 'STAGED', reference })
    const beef = Beef.fromBinary(signable.tx)
    const vin0Vout = Number(listingOutpoint.split('_')[1])
    const tx = beef.txs.find((entry) =>
      entry.tx?.inputs.some(
        (input) =>
          String(input.sourceTXID).toLowerCase() === itemTxid &&
          input.sourceOutputIndex === vin0Vout
      )
    )?.tx
    if (!tx) throw new Error('Market listing transaction is missing item input')
    const selectedPoints = new Set([
      listingOutpoint,
      ...extraCoverTips.map((tip) => tip.outpoint),
    ])
    if (
      String(tx.inputs[0]?.sourceTXID).toLowerCase() !== itemTxid ||
      tx.inputs[0]?.sourceOutputIndex !== vin0Vout ||
      !selectedPoints.has(
        `${String(tx.inputs[0]?.sourceTXID).toLowerCase()}_${tx.inputs[0]?.sourceOutputIndex}`,
      ) ||
      tx.outputs[MARKET_ITEM_VOUT]?.satoshis !== 1 ||
      tx.outputs[MARKET_ITEM_VOUT]?.lockingScript?.toHex() !== itemLockingScript ||
      tx.outputs[MARKET_OFFER_VOUT]?.satoshis !== MARKET_OFFER_DEPOSIT_SATS ||
      tx.outputs[MARKET_OFFER_VOUT]?.lockingScript?.toHex() !== offerLockingScript
    ) {
      throw new MarketListingError(
        'MARKET_LISTING_SHAPE_MISMATCH',
        'Wallet did not preserve BRC-159 item/input and offer output ordering.'
      )
    }
    const spends: Record<number, { unlockingScript: string }> = {}
    for (let i = 0; i < tx.inputs.length; i += 1) {
      const vin = tx.inputs[i]!
      const src = `${String(vin.sourceTXID).toLowerCase()}_${vin.sourceOutputIndex}`
      if (i !== 0 && !selectedPoints.has(src)) continue
      vin.sourceTransaction ??=
        listingBeef.findTxid(String(vin.sourceTXID))?.tx ??
        beef.findTxid(String(vin.sourceTXID))?.tx
      const sourceOut = vin.sourceTransaction?.outputs[vin.sourceOutputIndex]
      const satoshis = sourceOut?.satoshis
      const lockingScript = sourceOut?.lockingScript
      if (typeof satoshis !== 'number' || !lockingScript) {
        throw new Error('Listing input is missing its source locking script')
      }
      // 162 and 1sat tips are prefix ‖ P2PKH. getUnlockP2PKH hashes bare P2PKH
      // and fails CHECKSIG ("top stack element must be truthy").
      vin.unlockingScriptTemplate = new P2PKH().unlock(
        offerKey,
        'all',
        false,
        satoshis,
        lockingScript,
      )
    }
    await tx.sign()
    for (let i = 0; i < tx.inputs.length; i += 1) {
      const unlockingScript = tx.inputs[i]?.unlockingScript?.toHex()
      if (!unlockingScript) {
        if (i === 0) throw new Error('Market item signature missing')
        continue
      }
      spends[i] = { unlockingScript }
    }
    if (!spends[0]) throw new Error('Market item signature missing')
    chart.send({ type: 'SIGNED_UNKNOWN' })
    const signed = await active.wallet.signAction({
      reference,
      spends,
      options: {
        noSend: true,
        acceptDelayedBroadcast: true,
      },
    })
    const txid = signed.txid?.toLowerCase() ?? ''
    const atomic = signed.tx ? Array.from(signed.tx) : []
    signedTxid = /^[0-9a-f]{64}$/.test(txid) ? txid : null
    signedAtomic = atomic.length > 0 ? atomic : null
    if (!signedTxid || !signedAtomic) {
      chart.send({ type: 'RECOVER' })
      throw new MarketListingError(
        'MARKET_LISTING_BROADCAST_UNKNOWN',
        'Listing was signed but wallet processing did not return a transaction.'
      )
    }
    // Accept on Arcade contact / non-immediate-fail — do not require SPV
    // "valid on chain main" before the listing is considered broadcast.
    const mined = await submitAtomicBeefToMiners(txid, atomic, {
      flow: 'market_listing',
    })
    if (!mined.submitted && !mined.confirmed) {
      chart.send({ type: 'RECOVER' })
      throw new MarketListingError(
        'MARKET_LISTING_BROADCAST_UNKNOWN',
        'Listing was signed but Arcade did not accept the broadcast.',
      )
    }
    chart.send({ type: 'BROADCASTED', txid })
    const listedOutpoint = `${txid}_0`
    const offerOutpoint = `${txid}_1`
    const advert: MarketListingAdvert = {
      outpoint: listedOutpoint,
      offerOutpoint,
      offerLockingScript,
      assetType: listedAsset,
      amt,
      seller: fields.sellerIdentityKey,
      payTo: fields.payTo,
      priceSats: fields.grossPriceSats,
      feeIdentityKey: fields.feeIdentityKey,
      feePayTo: fields.feePayTo,
      feeBasisPoints: fields.feeBasisPoints,
      exactFeeSats: fields.exactFeeSats,
      depositSats: fields.depositSats,
      messagebox: fields.messagebox,
      origin,
      provenanceHash: fields.provenanceHash,
      provenanceSize: fields.provenanceSize,
      provenanceVersion: fields.provenanceVersion,
      listedAt,
      expiresAt: fields.expiresAt,
      nonce: fields.nonce,
    }
    try {
      const listingTx = Beef.fromBinary(atomic).findTxid(txid)?.tx
      if (!listingTx) {
        throw new Error('Listing transaction missing from AtomicBEEF')
      }
      advert.settlementUnlocks = await buildMarketSettlementUnlocks({
        listingTx,
        txid,
        itemLockingScript,
        offerLockingScript,
        payTo: fields.payTo,
        priceSats,
        feePayToAddress: fields.feePayTo,
        privateKey: offerKey,
      })
    } catch (err) {
      console.warn(
        '[market] list-time settlement pre-sign failed',
        err instanceof Error ? err.message : String(err),
      )
    }
    // Authorization is written only after signAction produced the processed result.
    saveAuthorization({
      key: listingAuthorizationKey(listedOutpoint, nonce),
      outpoint: listedOutpoint,
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
    if (
      !advert.settlementUnlocks?.itemUnlockingScript ||
      !advert.settlementUnlocks?.offerUnlockingScript
    ) {
      throw new MarketListingError(
        'MARKET_UNLOCKS_MISSING',
        'A list-time seller signature could not be built. The listing was not published.',
      )
    }
    chart.send({ type: 'COMMITTED' })
    scheduleHistoryBackupPush('market-list')
    rememberGhostTx(txid)
    const identity = listedActivityIdentity({
      inputOutpoint: listingOutpoint,
      origin,
      listedAsset,
      customName: typeof custom.name === 'string' ? custom.name : undefined,
      tags: output.tags,
      sym: lockTip?.sym,
      icon: lockTip?.icon,
    })
    // Listing replaces the held tip with txid.0. Paint that replacement now;
    // a market attempt or an unavailable indexer must never make owned assets
    // disappear while listOutputs catches up.
    if (listedAsset === 'bsv21' && amt != null) {
      void import('./token/list').then(({ rememberFungibleToken }) => {
        rememberFungibleToken({
          tokenId: origin,
          sym: lockTip?.sym || identity.name,
          amt: String(amt),
          dec: lockTip?.dec ?? 0,
          utxoCount: 1,
          outpoint: listedOutpoint.replace('_', '.'),
          spendKind: 'plain',
          ...(lockTip?.icon ? { icon: lockTip.icon } : {}),
          ...(lockTip?.issuer ? { issuer: lockTip.issuer } : {}),
        })
      })
    } else {
      void import('./collectables').then(({ noteIngestedItem }) => {
        noteIngestedItem({
          outpoint: listedOutpoint.replace('_', '.'),
          chain: active.chain,
          origin,
          name: identity.name,
          app: identity.app,
        })
      })
    }
    const listedNote =
      listedAsset === 'bsv21' && amt != null
        ? `Listed ${amt.toLocaleString()} ${identity.name} for ${priceSats.toLocaleString()} sats`
        : `Listed ${identity.name} for ${priceSats.toLocaleString()} sats`
    recordWalletEvent({
      method: 'market-list',
      note: listedNote,
      txid,
      item: {
        name: identity.name,
        origin,
        outpoint: listedOutpoint.replace('_', '.'),
        ...(identity.imageUrl ? { imageUrl: identity.imageUrl } : {}),
        ...(identity.app ? { app: identity.app } : {}),
        ...(listedAsset === 'bsv21'
          ? {
              tokenId: origin,
              ...(amt != null ? { amt: String(amt) } : {}),
              ...(lockTip?.icon ? { icon: lockTip.icon } : {}),
            }
          : {}),
      },
    })
    return {
      listing: advert,
      provenance,
      txid,
      beef: atomic,
      token: {
        outpoint: offerOutpoint,
        outputIndex: MARKET_OFFER_VOUT,
        satoshis: MARKET_OFFER_DEPOSIT_SATS,
        lockingScript: offerLockingScript,
        fields,
      },
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    const snap = chart.getSnapshot()
    const broadcastedTxid =
      typeof snap.context.txid === 'string' && /^[0-9a-f]{64}$/i.test(snap.context.txid)
        ? snap.context.txid.toLowerCase()
        : null
    // After Arcade accept / BROADCASTED, never abort or erase the spend — the
    // listing tx is already a real on-chain/mempool promise.
    if (broadcastedTxid || snap.matches('broadcast') || snap.matches('committed')) {
      // Stay in broadcast/committed — FAIL is not wired from those states, and
      // aborting would drop the real mempool/on-chain spend from history.
      recordWalletEvent({
        method: 'market-list',
        note: `Listed (broadcast ok; finish failed)`,
        txid: broadcastedTxid || undefined,
        status: 'failed',
        failureReason: reason.slice(0, 280),
        item: {
          name: listedAsset === 'bsv21' ? (lockTip?.sym || 'Token') : 'Collectable',
          origin,
          outpoint: broadcastedTxid
            ? `${broadcastedTxid}.0`
            : listingOutpoint.replace('_', '.'),
        },
      })
      throw err
    }
    const conflict = await abortUnsentMarketAction({
      active,
      reference,
      chart,
      tipOutpoint: listingOutpoint,
      reason,
      signedTxid,
      atomic: signedAtomic,
    })
    // Name the input that actually died. A dead funding coin must not read as
    // "Already spent" on an item the wallet just proved it can still spend.
    const failure =
      conflict === 'funding-spent'
        ? new MarketListingError(
            'LISTING_FUNDING_SPENT',
            'A coin that was going to pay for this listing had already been spent. It has been removed from the wallet — list again.',
          )
        : conflict === 'item-spent'
          ? new MarketListingError(
              'ITEM_NOT_HELD',
              'This item is already spent on chain. It was removed from Collectables.',
            )
          : err
    const failureReason =
      failure instanceof Error ? failure.message : String(failure)
    recordWalletEvent({
      method: 'market-list',
      note: 'Listing failed',
      status: 'failed',
      failureReason: failureReason.slice(0, 280),
      item: {
        name: listedAsset === 'bsv21' ? (lockTip?.sym || 'Token') : 'Collectable',
        origin,
        outpoint: listingOutpoint.replace('_', '.'),
      },
    })
    throw failure
  } finally {
    chart.stop()
  }
}

export async function verifyMarketListingProvenance(args: {
  listing: MarketListingAdvert
  provenance: unknown
}): Promise<{ verified: boolean; reason: string | null }> {
  const advert = args.listing
  const isBsv21 = advert.assetType === 'bsv21'
  const provenance = isBsv21
    ? parseBsv21ListingProof(args.provenance)
    : parseProvenanceV2(args.provenance)
  const fail = (reason: string) => ({ verified: false, reason })
  if (!provenance || advert.provenanceVersion !== 2) {
    return fail('INVALID_PROVENANCE_VERSION')
  }
  let outpoint: string
  let offerOutpoint: string
  let token: MarketOfferFields
  try {
    outpoint = normalizeOutpoint(advert.outpoint)
    offerOutpoint = normalizeOutpoint(advert.offerOutpoint)
    token = parseMarketOffer(advert.offerLockingScript)
  } catch (err) {
    return fail(
      `INVALID_LISTED_OUTPUT: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }
  if (
    outpoint.slice(0, 64) !== offerOutpoint.slice(0, 64) ||
    outpoint !== `${outpoint.slice(0, 64)}_0` ||
    offerOutpoint !== `${outpoint.slice(0, 64)}_1`
  ) {
    return fail('OFFER_ITEM_OUTPOINT_MISMATCH')
  }
  const digest = hashMarketProvenance(provenance)
  if (
    digest.hash !== advert.provenanceHash.toLowerCase() ||
    digest.size !== advert.provenanceSize
  ) {
    return fail('PROVENANCE_COMMITMENT_MISMATCH')
  }
  if (
    token.sellerIdentityKey !== advert.seller.toLowerCase() ||
    token.payTo !== advert.payTo ||
    token.grossPriceSats !== advert.priceSats ||
    token.feeIdentityKey !== advert.feeIdentityKey.toLowerCase() ||
    token.feePayTo !== advert.feePayTo ||
    token.feeBasisPoints !== advert.feeBasisPoints ||
    token.exactFeeSats !== advert.exactFeeSats ||
    token.provenanceHash !== digest.hash ||
    token.provenanceSize !== digest.size ||
    token.provenanceVersion !== advert.provenanceVersion ||
    token.expiresAt !== advert.expiresAt ||
    token.nonce !== advert.nonce.toLowerCase() ||
    token.depositSats !== advert.depositSats ||
    token.messagebox !== advert.messagebox
  ) {
    return fail('OFFER_TOKEN_TERMS_MISMATCH')
  }
  try {
    const proofOrigin = isBsv21
      ? (provenance as Bsv21ListingProof).tokenId
      : (provenance as ProvenanceV2).origin
    if (
      normalizeOriginOutpoint(proofOrigin) !==
      normalizeOriginOutpoint(advert.origin)
    ) {
      return fail('PROVENANCE_ORIGIN_MISMATCH')
    }
    if (
      isBsv21 &&
      advert.amt != null &&
      (provenance as Bsv21ListingProof).amt !== String(advert.amt)
    ) {
      return fail('PROVENANCE_AMT_MISMATCH')
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
  if (isBsv21) {
    return { verified: true, reason: null }
  }
  // Overlay BRC-150 proves the pre-list item tip. The listing outpoint is
  // output 0 of a new tx the buyer does not have in BEEF — do not treat it
  // as a held tip. Hash / origin / offer terms already bound the listing.
  //
  // Market buys pass a publish-complete proof (full path bodies). Verify that
  // locally so the buyer never waits on indexer getBeef (~8s each) before
  // spending. Only lean/incomplete proofs may hydrate, and they fail closed
  // quickly if bodies are still missing.
  const proofTip = (provenance as ProvenanceV2).tip
  const missing = provenanceMissingPathBodies(provenance)
  if (missing && missing.length > 0) {
    const active = getActiveWallet()
    if (!active) {
      return fail(
        `ITEM_ORIGIN_INCOMPLETE: BRC-150 proof is missing ${missing.length} path body(ies) and wallet is locked`,
      )
    }
    const verifiedLean = await verifyProvenanceForHeldTip({
      provenance: provenance as ProvenanceV2,
      heldOutpoint: proofTip,
      getBeef: (txid: string) => getBeefForTxidCached(active, txid, { needProof: true, allowUnprovenRawTx: true }),
    })
    return verifiedLean.proven
      ? { verified: true, reason: null }
      : fail(`ITEM_ORIGIN_UNPROVEN: ${verifiedLean.reason ?? 'unknown reason'}`)
  }
  const verified = await verifyProvenanceForHeldTip({
    provenance: provenance as ProvenanceV2,
    heldOutpoint: proofTip,
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
  return {
    priceSats: price,
    sellerSats: price - feeSats + MARKET_OFFER_DEPOSIT_SATS,
    feeSats,
  }
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
  const createdAt = Math.round(Date.now())
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
    expiresAt: createdAt + 15 * 60_000,
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

/**
 * A tip that left the wallet can no longer honor its local listing auth.
 * Mark active/reserved auths cancelled so Collect does not show a stale
 * "Listed" badge on a spent (or self-sent) outpoint.
 */
export function invalidateMarketListingsForSpentOutpoints(
  outpoints: readonly string[],
  reason = 'tip-spent',
): number {
  const keys = new Set<string>()
  for (const raw of outpoints) {
    try {
      // Authorizations are stored underscore-form (`txid_0`). normalizeOutpoint
      // accepts dotted tips from markItemsSent — never filter on `.` or the
      // whole batch becomes a no-op.
      keys.add(normalizeOutpoint(raw))
    } catch {
      // Skip malformed tips; one bad string must not cancel the rest.
    }
  }
  if (keys.size === 0) return 0
  const now = Date.now()
  let changed = 0
  const next = readAuthorizations().map((entry) => {
    if (!keys.has(normalizeOutpoint(entry.outpoint))) return entry
    if (entry.state !== 'active' && entry.state !== 'reserved') return entry
    changed += 1
    return {
      ...entry,
      state: 'cancelled' as const,
      updatedAt: now,
      reason,
      reservationSaleId: undefined,
      reservationBuyer: undefined,
      reservationUntil: undefined,
      reservationTxCommitment: undefined,
      reservationIntent: undefined,
    }
  })
  if (changed > 0) writeAuthorizations(next)
  return changed
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


/**
 * List-time SIGHASH_NONE|ANYONECANPAY on the item (buyer sets vout0) and
 * SIGHASH_SINGLE|ANYONECANPAY checksig-only on the offer (binds vout1 seller
 * payment). Publish fails closed when this cannot be built.
 */
export async function buildMarketSettlementUnlocks(args: {
  listingTx: Transaction
  txid: string
  itemLockingScript: string
  offerLockingScript: string
  payTo: string
  priceSats: number
  feePayToAddress: string
  privateKey: PrivateKey
}): Promise<MarketSettlementUnlocks> {
  const txid = args.txid.trim().toLowerCase()
  if (String(args.listingTx.id('hex')).toLowerCase() !== txid) {
    throw new Error('Listing transaction does not match txid')
  }
  const amounts = calculateMarketSettlement(args.priceSats)
  const itemLock = LockingScript.fromHex(args.itemLockingScript)
  const offerLock = LockingScript.fromHex(args.offerLockingScript)
  const skeleton = new Transaction()
  skeleton.addInput({
    sourceTXID: txid,
    sourceOutputIndex: MARKET_ITEM_VOUT,
    sourceTransaction: args.listingTx,
    unlockingScriptTemplate: new P2PKH().unlock(
      args.privateKey,
      'none',
      true,
      1,
      itemLock,
    ),
  })
  skeleton.addInput({
    sourceTXID: txid,
    sourceOutputIndex: MARKET_OFFER_VOUT,
    sourceTransaction: args.listingTx,
    unlockingScriptTemplate: checksigOnlyUnlock(
      args.privateKey,
      1,
      offerLock,
      'single',
      true,
    ),
  })
  skeleton.addOutput({
    satoshis: 1,
    lockingScript: new P2PKH().lock(args.payTo),
  })
  skeleton.addOutput({
    satoshis: amounts.sellerSats,
    lockingScript: new P2PKH().lock(args.payTo),
  })
  skeleton.addOutput({
    satoshis: amounts.feeSats,
    lockingScript: new P2PKH().lock(args.feePayToAddress),
  })
  await skeleton.sign()
  const itemUnlockingScript = skeleton.inputs[0]?.unlockingScript?.toHex()
  const offerUnlockingScript = skeleton.inputs[1]?.unlockingScript?.toHex()
  if (!itemUnlockingScript || !offerUnlockingScript) {
    throw new Error('List-time settlement signatures missing')
  }
  return {
    version: 1,
    itemUnlockingScript,
    offerUnlockingScript,
    itemSighash: 'NONE|ANYONECANPAY',
    offerSighash: 'SINGLE|ANYONECANPAY',
    sellerSats: amounts.sellerSats,
    feeSats: amounts.feeSats,
  }
}

/** Offer lock is <pubkey> OP_CHECKSIG + PushDrop fields. Unlock is sig-only. */
function checksigOnlyUnlock(
  privateKey: PrivateKey,
  satoshis: number,
  lockingScript: { toHex?: () => string } | unknown,
  signOutputs: 'all' | 'none' | 'single' = 'all',
  anyoneCanPay = false,
) {
  const p2pkh = new P2PKH().unlock(
    privateKey,
    signOutputs,
    anyoneCanPay,
    satoshis,
    lockingScript as Parameters<P2PKH['unlock']>[4],
  )
  return {
    sign: async (tx: Parameters<typeof p2pkh.sign>[0], inputIndex: number) => {
      const full = await p2pkh.sign(tx, inputIndex)
      return new UnlockingScript(full.chunks.slice(0, 1))
    },
    estimateLength: async () => 73,
  }
}

function markMarketListingCancelled(args: {
  outpoint: string
  nonce: string
  txid?: string
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
  const listed = current.listing
  recordWalletEvent({
    method: 'market-cancel',
    note:
      listed?.assetType === 'bsv21'
        ? 'Cancelled token listing'
        : 'Cancelled listing',
    ...(args.txid ? { txid: args.txid } : {}),
    item: listed
      ? {
          name: listed.assetType === 'bsv21' ? 'Token' : 'Collectable',
          origin: listed.origin,
          outpoint: listed.outpoint,
        }
      : undefined,
  })
  return cancelled
}

export async function createCancelMarketListingAdvert(args: {
  outpoint: string
  nonce?: string
}): Promise<MarketCancelAdvert> {
  return runExclusiveSpend(
    () => createCancelMarketListingAdvertExclusive(args),
    undefined,
    { promote: false },
  )
}

async function createCancelMarketListingAdvertExclusive(args: {
  outpoint: string
  nonce?: string
}): Promise<MarketCancelAdvert> {
  const current = getMarketListingAuthorization(args)
  if (!current) {
    throw new MarketListingError('LISTING_NOT_AUTHORIZED', 'Listing not found.')
  }
  const active = getActiveWallet()
  if (!active) throw new MarketListingError('WALLET_LOCKED', 'Wallet locked')
  await prepareMarketListingSpend(active)
  const listing = current.listing
  if (!listing) throw new MarketListingError('INVALID_OFFER', 'Listing token is missing.')
  let valid = false
  try {
    parseMarketOffer(listing.offerLockingScript)
    valid = true
  } catch {
    valid = false
  }
  const held = await active.wallet.listOutputs({
    basket: 'market-offers',
    tags: [`nonce:${current.nonce}`],
    tagQueryMode: 'all',
    include: 'locking scripts',
    limit: 2,
    seekPermission: false,
  })
  const offerHeld = held.outputs.some(
    (output) => normalizeOutpoint(output.outpoint) === normalizeOutpoint(listing.offerOutpoint)
  )
  const path = chooseMarketCancelPath({
    offerOutpoint: listing.offerOutpoint,
    held: offerHeld,
    valid,
    active: current.state === 'active',
  })
  if (path.path === 'refuse') {
    throw new MarketListingError('MARKET_CANCEL_REFUSED', path.reason)
  }
  const chart = createActor(marketListingMachine).start()
  chart.send({ type: 'CANCEL', path })
  let reference: string | null = null
  try {
    const offerTxid = listing.offerOutpoint.slice(0, 64)
    const inputBEEF = (await getBeefForTxidCached(active, offerTxid, { needProof: true })).toBinary()
    const created = await active.wallet.createAction({
      description: 'Cancel BRC-48 market offer',
      labels: ['market-v3', 'brc48', 'market-cancel'],
      inputBEEF,
      inputs: [
        {
          outpoint: listing.offerOutpoint.replace('_', '.'),
          inputDescription: 'Cancelled market offer',
          unlockingScriptLength: 73,
        },
      ],
      options: {
        randomizeOutputs: false,
        signAndProcess: false,
        trustSelf: 'known',
      },
    })
    const signable = created.signableTransaction
    if (!signable) throw new Error('Cancellation did not return a signable action')
    reference = signable.reference
    chart.send({ type: 'STAGED', reference })
    const beef = Beef.fromBinary(signable.tx)
    const tx = beef.txs.find((entry) =>
      entry.tx?.inputs.some(
        (input) =>
          String(input.sourceTXID).toLowerCase() === offerTxid &&
          input.sourceOutputIndex === MARKET_OFFER_VOUT
      )
    )?.tx
    if (
      !tx ||
      String(tx.inputs[0]?.sourceTXID).toLowerCase() !== offerTxid ||
      tx.inputs[0]?.sourceOutputIndex !== MARKET_OFFER_VOUT
    ) {
      throw new Error('Cancellation must spend the offer token as input zero')
    }
    {
      const vin = tx.inputs[0]!
      vin.sourceTransaction ??= beef.findTxid(String(vin.sourceTXID))?.tx
      const sourceOut = vin.sourceTransaction?.outputs[vin.sourceOutputIndex]
      const satoshis = sourceOut?.satoshis
      const lockingScript = sourceOut?.lockingScript
      if (typeof satoshis !== 'number' || !lockingScript) {
        throw new Error('Cancel input is missing its source locking script')
      }
      vin.unlockingScriptTemplate = checksigOnlyUnlock(
        PrivateKey.fromHex(active.rootKeyHex),
        satoshis,
        lockingScript,
      )
    }
    await tx.sign()
    const unlockingScript = tx.inputs[0]?.unlockingScript?.toHex()
    if (!unlockingScript) throw new Error('Offer cancellation signature missing')
    chart.send({ type: 'SIGNED_UNKNOWN' })
    const signed = await active.wallet.signAction({
      reference,
      spends: { 0: { unlockingScript } },
      options: { acceptDelayedBroadcast: false },
    })
    const txid = signed.txid?.toLowerCase() ?? ''
    const beefBytes = signed.tx ? Array.from(signed.tx) : []
    if (!/^[0-9a-f]{64}$/.test(txid) || beefBytes.length === 0) {
      chart.send({ type: 'RECOVER' })
      throw new Error('Cancellation broadcast result is unknown')
    }
    chart.send({ type: 'BROADCASTED', txid })
    markMarketListingCancelled({
      outpoint: current.outpoint,
      nonce: current.nonce,
      txid,
    })
    chart.send({ type: 'COMMITTED' })
    scheduleHistoryBackupPush('market-list')
    return {
      action: 'cancel',
      itemOutpoint: current.outpoint,
      offerOutpoint: listing.offerOutpoint,
      txid,
      beef: beefBytes,
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    const snap = chart.getSnapshot()
    const broadcastedTxid =
      typeof snap.context.txid === 'string' && /^[0-9a-f]{64}$/i.test(snap.context.txid)
        ? snap.context.txid.toLowerCase()
        : null
    if (broadcastedTxid || snap.matches('broadcast') || snap.matches('committed')) {
      throw err
    }
    await abortUnsentMarketAction({
      active,
      reference,
      chart,
      tipOutpoint: listing.offerOutpoint,
      reason,
    })
    throw err
  } finally {
    chart.stop()
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
  beef?: number[]
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


export function markMarketListingPublishFailed(args: {
  txid?: string
  reason?: string
}): void {
  failMarketListingActivity({
    txid: args.txid,
    reason: args.reason || 'Could not publish listing',
  })
}

function listingOutpointFromActivity(entry: {
  txid?: string
  item?: { outpoint?: string }
}): string | null {
  const fromItem = entry.item?.outpoint?.trim()
  if (fromItem) return fromItem.replace('.', '_')
  const txid = entry.txid?.trim().toLowerCase()
  if (txid && /^[0-9a-f]{64}$/.test(txid)) return `${txid}_0`
  return null
}

/** Cancel local listing auth after overlay rejected a signed listing. */
export function releaseFailedMarketListingAuth(entry: ActivityEntry): void {
  const outpoint = listingOutpointFromActivity(entry)
  if (!outpoint) return
  const auth = listMarketListingAuthorizations().find((row) => row.outpoint === outpoint)
  if (!auth || (auth.state !== 'active' && auth.state !== 'reserved')) return
  try {
    updateMarketListingAuthorization({
      outpoint: auth.outpoint,
      nonce: auth.nonce,
      from: ['active', 'reserved'],
      to: 'cancelled',
      reason: 'dismissed-from-activity',
    })
  } catch {
    // auth already moved
  }
}

/**
 * Drop a failed market listing row and release local listing auth so inventory
 * can list again. On-chain offer UTXOs may still exist — cancel separately if needed.
 */
export function dismissFailedMarketListingActivity(entry: ActivityEntry): boolean {
  releaseFailedMarketListingAuth(entry)
  return removeActivityById(entry.id)
}
