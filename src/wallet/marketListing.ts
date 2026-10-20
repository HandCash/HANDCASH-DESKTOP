import { getActiveWallet } from './session'
import { looksLikeBnt } from './bnt/script'
import { storageRegistry } from '../storage/registry'

import {
  Beef,
  BigNumber,
  Hash,
  KeyDeriver,
  P2PKH,
  PrivateKey,
  PublicKey,
  Signature,
  Transaction,
  UnlockingScript,
  Utils,
} from '@bsv/sdk'
import { createActor } from 'xstate'
import { mayAbortOffer, offerMachine } from '../machines/offerMachine'
import { normalizeAppHost } from './appIdentity'
import { type ActiveWallet } from './session'
import { durableGetItem, durableSetItem } from './durableStorage'
import { accountLocalKey } from './accountLocalKeys'
import { runExclusiveSpend } from './spendGuard'
import { isAlreadySpentListingFailure } from './spendVerdict'
import { trustsLocalHandCashHosts } from './labs'
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
import { looksLikeRetiredFungibleTip } from './retiredFungible'
import { ITEM_STORAGE_BASKET } from './assetBaskets'
import { getBeefForTxidCached, getLocalBeefForTxid } from './beefCache'
import { withStorageLockLabel } from './storageLockTrace'
import { getProvenVerdict } from './provenCache'
import { toUnderscoreOutpoint } from './outpointFormat'
import {
  MARKET_FEE_BASIS_POINTS,
  MARKET_FEE_IDENTITY_KEY,
  MARKET_FEE_PAY_TO_ADDRESS,
} from './walletConfig'
import {
  failMarketListingActivity,
  noteMarketListingPublished,
  noteMarketListingUnpublished,
  recordWalletEvent,
  removeActivityById,
  type ActivityEntry,
} from './appActivity'
import { signedChequeAtomic } from './signedChequeArchive'
import { getTxByTxid } from './txStore'
import { getCachedCollectables } from './collectables'
import { rememberGhostTx } from './ghostTxSuppress'
import { scheduleHistoryBackupPush } from './deviceSync'
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
  chooseMarketCancelReturn,
  chooseMarketListingPath,
  type MarketCancelReturn,
} from './marketListingPath'
import { publicMessageboxBase } from './messageTransport'
import {
  MARKET_SETTLEMENT_VERSION,
  isMarketPayoutIndexPair,
  marketSettlementShape,
  type MarketSettlementUnlocksV2,
} from './marketSettlementLayout'
import { signSellerInputs } from './offerSeal'
import { SELLER_SIGHASH } from './offerTerms'
import { rememberTipKey, selfTokenOutput, tipSigningKey } from './tipKeys'
import { heldItemRow } from './itemRecipientKey'
import { brc29PrivateKey, selfBrc29Output, type Remittance } from './brc29Keys'

export const MARKET_PURCHASE_INTENT_PROTOCOL =
  'HandCash-Market-Purchase-Intent-v1'
export const MARKET_SETTLEMENT_RECEIPT_PROTOCOL =
  'HandCash-Market-Settlement-Receipt-v1'
export const MARKET_PROVENANCE_VERSION = 2 as const
const LISTING_AUTH_STORAGE_KEY = storageRegistry.listingAuthorizations.key

function listingAuthorizationStorageKey(): string {
  return accountLocalKey(LISTING_AUTH_STORAGE_KEY)
}

/**
 * Listing authorizations have no account-owned in-memory cache. Kept as the
 * standard account-switch hook so callers can rebind every market surface.
 */
export function rebindMarketListingForAccount(): void {}

export type MarketListingAdvert = {
  outpoint: string
  offerOutpoint: string
  offerLockingScript: string
  assetType: MarketAssetType
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

export type MarketSettlementUnlocks = MarketSettlementUnlocksV2

export type CreateMarketListingArgs = {
  outpoint: string
  assetType?: MarketAssetType
  priceSats: number
  expiresAt?: number | null
  messagebox?: string | null
}

export type MarketListingPostPayload = {
  listing: MarketListingAdvert
  provenance: ProvenanceV2
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
  /**
   * The address the buyer item output pays: a BRC-29 child of the buyer, never
   * its identity address. Signed when present; receipts from 1.3.596 and
   * earlier omit it and the index derives the identity address.
   */
  buyerAddress?: string
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

/**
 * Whether the listings index carries this offer. Orthogonal to `state`: an
 * `active` offer is on chain either way, and a buyer holding the advert can
 * still settle it with the list-time unlocks. Absent = listed before 1.3.383,
 * treated as published.
 */
export type MarketPublishState =
  | { kind: 'published'; at: number }
  | { kind: 'unpublished'; reason: string; at: number }

/** What the seller's own surfaces may say about a live listing. */
export type MarketListingMark =
  | { kind: 'listed'; priceSats: number }
  | { kind: 'unpublished'; priceSats: number; reason: string }

export type MarketListingAuthorization = {
  key: string
  outpoint: string
  nonce: string
  seller: string
  origin: string
  provenanceHash: string
  priceSats: number
  state: MarketListingState
  publish?: MarketPublishState
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
  /** BRC-29 children of a v2 listing; absent for v1, which used the identity key. */
  sellerKeys?: MarketSellerKeys
}

/**
 * The seller's BRC-29 children for one v2 listing (BRC-254): the listing key
 * locks the listed output and the offer token, the payout receives the sale.
 * Kept on the authorization and on the offer output, which BRC-39 backs up.
 */
export type MarketSellerKeys = { listing: Remittance; payout: Remittance }

function planMarketSellerKeys(active: ActiveWallet): {
  listingKey: PrivateKey
  listingAddress: string
  payTo: string
  keys: MarketSellerKeys
} {
  const listing = selfBrc29Output(active)
  const payout = selfBrc29Output(active, listing.remittance.derivationPrefix)
  rememberTipKey(active, listing.key)
  return {
    listingKey: listing.key,
    listingAddress: listing.address,
    payTo: payout.address,
    keys: { listing: listing.remittance, payout: payout.remittance },
  }
}

/** The key that signs a listing's offer token and plain listed output: BRC-29 (v2) or the root (v1). */
export function marketListingKey(active: ActiveWallet, sellerKeys?: MarketSellerKeys): PrivateKey {
  const root = PrivateKey.fromHex(active.rootKeyHex)
  return sellerKeys ? brc29PrivateKey(root, sellerKeys.listing) : root
}

/** Compact tokens and items are filed apart from 1Sat items and are not ordinals. */
function isBntRow(row: { tags?: string[]; lockingScript?: unknown }): boolean {
  return (
    (row.tags ?? []).includes('bnt') ||
    (typeof row.lockingScript === 'string' && looksLikeBnt(row.lockingScript))
  )
}

export class MarketListingError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'MarketListingError'
  }
}


/** What a listing sells: a 1Sat item. */
export type MarketAssetType = 'ordinal'

function provenanceFromCustomInstructions(
  customInstructions: unknown,
): ProvenanceV2 | null {
  let value = customInstructions
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const provenance = (value as { provenance?: unknown }).provenance
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) {
    return null
  }
  const candidate = provenance as ProvenanceV2
  return candidate.v === 2 &&
    typeof candidate.origin === 'string' &&
    typeof candidate.tip === 'string' &&
    Array.isArray(candidate.path) &&
    typeof candidate.beefB64 === 'string'
    ? candidate
    : null
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
}): { name: string; imageUrl?: string; app?: string } {
  const input = args.inputOutpoint.trim().toLowerCase().replace(/_/g, '.')
  const origin = args.origin.trim().toLowerCase().replace(/\./g, '_')
  const held = getCachedCollectables().find((c) => {
    const op = c.outpoint.trim().toLowerCase().replace(/_/g, '.')
    const og = c.origin.trim().toLowerCase().replace(/\./g, '_')
    return op === input || og === origin
  })
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

/** Classify a held tip. Removed protocols are refused. */
export function classifyMarketListingAsset(args: {
  outpoint: string
  satoshis?: number
  tags?: string[]
  customInstructions?: string
  lockingScriptHex?: string
}): {
  assetType: MarketAssetType
  refuse?: 'retired-protocol'
} {
  if (
    looksLikeRetiredFungibleTip({
      tags: args.tags,
      customInstructions: args.customInstructions,
      lockingScriptHex: args.lockingScriptHex,
    })
  ) {
    return { assetType: 'ordinal', refuse: 'retired-protocol' }
  }
  return { assetType: 'ordinal' }
}

/** Files the listing key's remittance on the listed output so BRC-39 carries it and listings recognise it. */
function heldWithListingKey(
  keys: MarketSellerKeys,
  held: { basket: string; tags: string[]; customInstructions: string },
): { basket: string; tags: string[]; customInstructions: string } {
  return { ...held, ...heldItemRow(held, keys.listing) }
}

export function buildMarketHeldRemittance(args: {
  assetType: MarketAssetType
  origin: string
  name?: string
  provenance?: ProvenanceV2
  extraTags?: string[]
}): { basket: string; tags: string[]; customInstructions: string } {
  const customInstructions = buildCollectableCustomInstructions({
    origin: args.origin,
    name: args.name?.trim() || 'Market item',
    provenance: args.provenance,
  })
  return {
    basket: ITEM_STORAGE_BASKET,
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
  if (bare === 'localhost' || bare === '127.0.0.1') return trustsLocalHandCashHosts()
  return (
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
    ...(receipt.buyerAddress ? [receipt.buyerAddress] : []),
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
  provenance: ProvenanceV2,
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

/**
 * Purchase intents and settlement receipts (BRC-254 §9) are signed the way
 * BRC-100 `createSignature` signs: the signer's child for this protocol, key ID
 * `1`, counterparty `anyone`. Records from 1.3.596 and earlier were signed raw
 * by the identity key and still verify.
 */
const MARKET_RECORD_SIGNATURE_PROTOCOL: [2, string] = [2, '1sat market record']
const MARKET_RECORD_SIGNATURE_KEY_ID = '1'

function recordSignatureHex(rootKeyHex: string, preimage: string): string {
  const signer = new KeyDeriver(PrivateKey.fromHex(rootKeyHex)).derivePrivateKey(
    MARKET_RECORD_SIGNATURE_PROTOCOL,
    MARKET_RECORD_SIGNATURE_KEY_ID,
    'anyone',
  )
  const signature = signer.sign(
    Utils.toArray(preimage, 'utf8'),
    undefined,
    true
  )
  return Utils.toHex([
    ...signature.r.toArray('be', 32),
    ...signature.s.toArray('be', 32),
  ])
}

function verifyRecordSignature(identityKey: string, signatureHex: string, preimage: string): boolean {
  let child: PublicKey
  try {
    child = new KeyDeriver('anyone').derivePublicKey(
      MARKET_RECORD_SIGNATURE_PROTOCOL,
      MARKET_RECORD_SIGNATURE_KEY_ID,
      identityKey,
    )
  } catch {
    return false
  }
  return verifyRawSignature(child, signatureHex, preimage) || verifyRawSignature(identityKey, signatureHex, preimage)
}

function verifyRawSignature(
  signerKey: string | PublicKey,
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
      typeof signerKey === 'string' ? PublicKey.fromString(signerKey) : signerKey
    )
  } catch {
    return false
  }
}

export type MarketListingPreview = {
  itemOutpoint?: string
  itemName?: string
  itemImageUrl?: string
  previewKind?: 'collectable'
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
  const provenance =
    body.provenance && typeof body.provenance === 'object' && !Array.isArray(body.provenance)
      ? (body.provenance as Record<string, unknown>)
      : null
  const text = (...values: unknown[]): string => {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
    return ''
  }
  const name = text(listing.name, provenance?.name)
  const contentUrl = text(listing.contentUrl, provenance?.contentUrl)
  return {
    itemOutpoint: outpoint.replace(/_(\d+)$/, '.$1'),
    itemName: name || 'Collectable',
    ...(contentUrl ? { itemImageUrl: contentUrl } : {}),
    previewKind: 'collectable',
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
    verifyRecordSignature(
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
    isMarketPayoutIndexPair(receipt.sellerOutputIndex, receipt.feeOutputIndex) &&
    Number.isSafeInteger(receipt.settledAt) &&
    Math.abs(now - receipt.settledAt) <= 15 * 60_000 &&
    verifyRecordSignature(
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
      durableGetItem(listingAuthorizationStorageKey()) ?? '[]'
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
  durableSetItem(listingAuthorizationStorageKey(), JSON.stringify(records))
}

function saveAuthorization(record: MarketListingAuthorization): void {
  const records = readAuthorizations().filter((item) => item.key !== record.key)
  writeAuthorizations([...records, record])
}

/** A sale found on the listing's payout child with no receipt: settled and collected. */
export function markMarketPayoutCollected(args: {
  outpoint: string
  nonce: string
  settlementTxid: string
  itemRetired: boolean
}): void {
  const current = getMarketListingAuthorization(args)
  if (!current) return
  saveAuthorization({
    ...current,
    state: 'settled',
    reason: args.settlementTxid.toLowerCase(),
    settlementTxid: current.settlementTxid ?? args.settlementTxid.toLowerCase(),
    proceedsInternalized: true,
    itemRetired: current.itemRetired || args.itemRetired || undefined,
    updatedAt: Date.now(),
  })
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

/**
 * Bind a sale id and buyer to a listing that was never reserved.
 *
 * A buyer using list-time unlocks settles without a sign hop, so the sale is
 * identified by the settlement transaction rather than by a reservation. Stamping
 * it here makes the receipt idempotent: a redelivered message finds the same
 * record by sale id and resumes wherever the previous pass stopped.
 */
export function adoptMarketSaleReceipt(args: {
  outpoint: string
  nonce: string
  saleId: string
  buyerIdentityKey: string
}): MarketListingAuthorization {
  const current = getMarketListingAuthorization(args)
  if (!current) {
    throw new MarketListingError('LISTING_NOT_AUTHORIZED', 'Listing not found.')
  }
  const next: MarketListingAuthorization = {
    ...current,
    reservationSaleId: args.saleId,
    reservationBuyer: args.buyerIdentityKey.trim().toLowerCase(),
    updatedAt: Date.now(),
  }
  saveAuthorization(next)
  return next
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

type ListedTip = {
  outpoint: string
  satoshis?: number
  tags?: string[]
  customInstructions?: string
  lockingScript?: string
}

type HeldListingRow = {
  outputId?: number
  basketId?: number | null
  spendable?: boolean
  satoshis?: number
  customInstructions?: string | null
  lockingScript?: number[] | Uint8Array | null
}

type HeldListingStorage = {
  findUserByIdentityKey?: (identityKey: string) => Promise<{ userId: number } | undefined>
  findOutputBaskets?: (args: {
    partial: { basketId?: number }
  }) => Promise<Array<{ basketId: number; name?: string }>>
  findOutputs?: (args: {
    partial: { userId: number; txid: string; vout: number }
    noScript?: boolean
  }) => Promise<HeldListingRow[]>
  findOutputTagMaps?: (args: {
    partial: { outputId: number }
  }) => Promise<Array<{ outputTagId: number; isDeleted?: boolean }>>
  findOutputTags?: (args: {
    partial: { outputTagId: number }
  }) => Promise<Array<{ tag?: string; isDeleted?: boolean }>>
}

function lockingScriptHexFromBytes(
  raw: number[] | Uint8Array | null | undefined,
): string | undefined {
  if (!raw || raw.length === 0) return undefined
  return Utils.toHex(raw instanceof Uint8Array ? Array.from(raw) : raw)
}

/**
 * The tip the seller selected, read by its txid and output index.
 *
 * A basket `listOutputs` with scripts and remittance walks every held item.
 * On a ~1,000-item wallet that hold ran past 70s and the listing was abandoned
 * before it signed. The selected outpoint is already known, so the row is one
 * indexed read plus that row's own tags.
 */
async function readListedOutputByOutpoint(
  active: ActiveWallet,
  outpoint: string,
): Promise<ListedTip | 'unsupported' | undefined> {
  const dotted = outpoint.replace('_', '.')
  const [txid, voutText] = dotted.split('.')
  const vout = Number(voutText)
  const storage = (
    active.wallet as {
      storage?: {
        runAsStorageProvider?: <T>(fn: (sp: unknown) => Promise<T>) => Promise<T>
      }
    }
  ).storage
  if (!storage?.runAsStorageProvider || !txid || !Number.isInteger(vout)) return 'unsupported'
  return withStorageLockLabel('listedOutput', () =>
    storage.runAsStorageProvider!(async (raw) => {
      const sp = raw as HeldListingStorage
      if (!sp.findUserByIdentityKey || !sp.findOutputs || !sp.findOutputBaskets) {
        return 'unsupported' as const
      }
      const user = await sp.findUserByIdentityKey(active.identityKey)
      if (!user) return undefined
      const rows = await sp.findOutputs({
        partial: { userId: user.userId, txid, vout },
        noScript: false,
      })
      const basketName = new Map<number, string>()
      for (const row of rows) {
        if (row.basketId == null || basketName.has(row.basketId)) continue
        const [basket] = await sp.findOutputBaskets({ partial: { basketId: row.basketId } })
        if (basket?.name) basketName.set(row.basketId, basket.name)
      }
      const hit = rows.find(
        (row) => row.spendable && basketName.get(row.basketId ?? -1) === ITEM_STORAGE_BASKET,
      )
      if (!hit) return undefined
      const tags: string[] = []
      if (sp.findOutputTagMaps && sp.findOutputTags && hit.outputId != null) {
        const maps = await sp.findOutputTagMaps({ partial: { outputId: hit.outputId } })
        for (const map of maps) {
          if (map.isDeleted) continue
          const [tag] = await sp.findOutputTags({ partial: { outputTagId: map.outputTagId } })
          if (tag && !tag.isDeleted && tag.tag) tags.push(tag.tag)
        }
      }
      return {
        outpoint: dotted,
        satoshis: hit.satoshis,
        tags,
        customInstructions: hit.customInstructions ?? undefined,
        lockingScript: lockingScriptHexFromBytes(hit.lockingScript),
      }
    }),
  )
}

/**
 * Dotted origin for a held tip, read from local caches only. Used only when
 * storage cannot answer by outpoint; a known origin then limits the tag query.
 */
function knownItemOriginTag(outpoint: string): string | null {
  const target = normalizeOutpoint(outpoint)
  const cached = getCachedCollectables().find(
    (item) => normalizeOutpoint(item.outpoint) === target,
  )
  const origin = cached?.origin ?? getProvenVerdict(target)?.origin
  if (!origin) return null
  const dotted = origin.trim().toLowerCase().replace(/_(\d+)$/, '.$1')
  return /^[0-9a-f]{64}\.\d+$/.test(dotted) ? dotted : null
}

async function loadListedOutput(
  outpoint: string,
  mark: (phase: string) => void = () => {},
) {
  const active = getActiveWallet()
  if (!active) throw new MarketListingError('WALLET_LOCKED', 'Wallet locked')
  // Only when storage has no outpoint index. A tag query still walks the tag
  // map; it never becomes a full basket read with scripts and remittance.
  const findByOriginTag = async (): Promise<ListedTip | undefined> => {
    const originTag = knownItemOriginTag(outpoint)
    if (!originTag) return undefined
    {
      const listed = await active.wallet.listOutputs({
        basket: ITEM_STORAGE_BASKET,
        limit: 25,
        includeTags: true,
        includeCustomInstructions: true,
        include: 'locking scripts',
        seekPermission: false,
        tags: [`origin:${originTag}`],
        tagQueryMode: 'all',
      })
      const hit = (listed.outputs ?? []).find(
        (candidate) => normalizeOutpoint(candidate.outpoint) === outpoint,
      )
      if (!hit) return undefined
      return {
        outpoint: hit.outpoint,
        satoshis: hit.satoshis,
        tags: hit.tags,
        customInstructions: hit.customInstructions,
        lockingScript: typeof hit.lockingScript === 'string' ? hit.lockingScript : undefined,
      }
    }
    return undefined
  }
  const readSelected = () => readListedOutputByOutpoint(active, outpoint)
  // Liveness is a network probe and the row read is local storage. Starting
  // both together means a list waits for the slower one, not for their sum.
  const liveness = tipStillUnspentOnChain(active, outpoint).catch(() => null)
  const located = await readSelected()
  let how: 'by outpoint' | 'origin tag' = located === 'unsupported' ? 'origin tag' : 'by outpoint'
  let output = located === 'unsupported' ? await findByOriginTag() : located
  if (!output) {
    // Prior Arcade hard-reject can leave the tip spendable=false while still on
    // chain. Revive once, then re-read that same outpoint.
    try {
      const { restoreUnspentAssetOutpoint } = await import('./staleOutputRelease')
      if (await restoreUnspentAssetOutpoint(active, outpoint.replace('_', '.'))) {
        const again = await readSelected()
        how = again === 'unsupported' ? 'origin tag' : 'by outpoint'
        output = again === 'unsupported' ? await findByOriginTag() : again
      }
    } catch {
      /* restore is best-effort */
    }
  }
  mark(`basket read ${output ? how : 'not held'}`)
  if (!output) {
    throw new MarketListingError(
      'ITEM_NOT_HELD',
      'The listed item is no longer held by this wallet.'
    )
  }
  if (isBntRow(output)) {
    throw new MarketListingError(
      'UNSUPPORTED_TOKEN_FORMAT',
      'BNT assets cannot be listed on the market yet.',
    )
  }
  // Basket rows lag the chain. A tip still listed locally but spent elsewhere
  // is what produces "Already spent" on list after a friend-send / prior list.
  const live = await liveness
  mark(`tip liveness probe ${live === false ? 'spent' : live === true ? 'live' : 'unknown'}`)
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
  if (classified.refuse === 'retired-protocol') {
    throw new MarketListingError(
      'MARKET_ASSET_UNSUPPORTED',
      'This retired asset protocol is not listable.',
    )
  }
  return {
    active,
    output,
    assetType: classified.assetType,
  }
}

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
    getSnapshot: () => Parameters<typeof mayAbortOffer>[0]
    send: (event: { type: 'ABORTED'; error: string } | { type: 'FAIL'; error: string }) => void
  }
  tipOutpoint: string
  reason: string
  /** Signed listing txid when Arcade rejected after signAction. */
  signedTxid?: string | null
  atomic?: number[] | null
}): Promise<MarketSpendConflict> {
  const snap = args.chart.getSnapshot()
  if (!mayAbortOffer(snap)) {
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

export { isAlreadySpentListingFailure }

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
      // Only trust an affirmative live answer. Indexer silence / errors answer
      // `false` for unseen change — that must not count as proven spent.
      if (result === true) return true
      if (
        result &&
        typeof result === 'object' &&
        (result as { isUtxo?: unknown }).isUtxo === true
      ) {
        return true
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

/**
 * Beef the app submits to the overlay. signAction's atomic package often
 * leaves an unconfirmed mint as a txid stub, and the overlay then cannot see
 * the spent output (`invalid-previous-item-tip`). The item BEEF already holds
 * that output; fold it in and keep the listing tx as the atomic subject.
 */
function listingAdvertBeef(
  atomic: number[],
  parents: { toBinary: () => number[] | Uint8Array } | undefined,
  txid: string,
): number[] {
  if (!parents) return atomic
  try {
    const merged = Beef.fromBinary(Uint8Array.from(atomic))
    const raw = parents.toBinary()
    merged.mergeBeef(raw instanceof Uint8Array ? Array.from(raw) : raw)
    merged.atomicTxid = undefined
    const framed = Array.from(merged.toBinaryAtomic(txid))
    return framed.length > 0 ? framed : atomic
  } catch {
    return atomic
  }
}

export async function createMarketListingAdvert(
  args: CreateMarketListingArgs
): Promise<MarketListingPostPayload> {
  // Serialize with consolidate / other spends so fee inputs are not raced, and
  // so a prior failed list's reserved tip can be aborted before we scan.
  const requestedAt = Date.now()
  return runExclusiveSpend(
    () => createMarketListingAdvertExclusive(args, requestedAt),
    undefined,
    { promote: false },
  )
}

async function createMarketListingAdvertExclusive(
  args: CreateMarketListingArgs,
  requestedAt: number = Date.now(),
): Promise<MarketListingPostPayload> {
  // Same phase timing the purchase path logs: a slow list has to name which
  // phase paid for it (queue wait, basket read, BRC-150 rebuild, miner ack).
  const mark = (phase: string) => {
    console.info(`[market-list] +${Date.now() - requestedAt}ms ${phase}`)
  }
  mark('spend region acquired')
  const outpoint = normalizeOutpoint(args.outpoint)
  const listingOutpoint = outpoint
  const itemTxid = listingOutpoint.slice(0, 64)
  const activeEarly = getActiveWallet()
  if (!activeEarly) throw new MarketListingError('WALLET_LOCKED', 'Wallet locked')
  await prepareMarketListingSpend(activeEarly)
  mark('reservations cleared')
  const { active, output, assetType: listedAsset } = await loadListedOutput(outpoint, mark)
  mark(`item loaded asset=${listedAsset}`)
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
  const origin = resolveOrdinalListingOrigin({
    outpoint,
    customOrigin: custom.origin,
    tags: output.tags,
  })
  // Inventory paints "verified" from durable provenCache; remittance is often
  // absent from customInstructions (internalize 1k cap). Rebuild the same way
  // collectable send does — trust the verdict, replay its path, allow a
  // publish-sized package the overlay size-gates separately.
  const remittanceProvenance =
    provenanceFromCustomInstructions(output.customInstructions) ??
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
  mark(`brc-150 rebuilt built=${String(Boolean(built))} trusted=${String(trustProven)}`)
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
  mark(
    `brc-150 publish package hydrated=${String(Boolean(complete))} outstanding=${outstanding?.length ?? 0}`,
  )
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
  mark('brc-150 publish package verified')
  const provenance = chosen
  const digest = hashMarketProvenance(provenance)
  const nonce = randomNonce()
  const exactFeeSats = Math.floor(
    (priceSats * MARKET_FEE_BASIS_POINTS) / 10_000
  )
  const seller = planMarketSellerKeys(active)
  const fields = normalizeMarketOfferFields({
    sellerIdentityKey: active.identityKey,
    listingKey: seller.listingKey.toPublicKey().toString(),
    payTo: seller.payTo,
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
  const offerKey = seller.listingKey
  const offerLockingScript = encodeMarketOffer(fields, PrivateKey.fromHex(active.rootKeyHex))
  const itemLockingScript = new P2PKH().lock(seller.listingAddress).toHex()
  const path = chooseMarketListingPath({
    itemOutpoint: listingOutpoint,
    satoshis: output.satoshis ?? 0,
    ordinal: (output.tags ?? []).some((tag) => tag.toLowerCase() === 'ordinal'),
    provenanceProven: true,
    termsValid: true,
  })
  if (path.path === 'refuse') {
    throw new MarketListingError('MARKET_LISTING_REFUSED', path.reason)
  }
  const chart = createActor(offerMachine).start()
  chart.send({ type: 'LIST', venue: 'market', path })
  const listingBeef = await getBeefForTxidCached(active, itemTxid, { needProof: true, allowUnprovenRawTx: true })
  mark('item beef ready')
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
      ],
      outputs: [
        {
          lockingScript: itemLockingScript,
          satoshis: 1,
          outputDescription: 'Held market item',
          ...heldWithListingKey(seller.keys, buildMarketHeldRemittance({
            assetType: listedAsset,
            origin,
            name:
              typeof custom.name === 'string' && custom.name.trim()
                ? custom.name.trim()
                : undefined,
            provenance,
            extraTags: ['market-held'],
          })),
        },
        {
          lockingScript: offerLockingScript,
          satoshis: MARKET_OFFER_DEPOSIT_SATS,
          outputDescription: 'BRC-48 market offer',
          basket: 'market-offers',
          tags: ['brc48', `nonce:${nonce}`, `origin:${origin.replace('_', '.')}`],
          customInstructions: JSON.stringify({ fields, sellerKeys: seller.keys }),
        },
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
    mark('action staged')
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
    if (
      String(tx.inputs[0]?.sourceTXID).toLowerCase() !== itemTxid ||
      tx.inputs[0]?.sourceOutputIndex !== vin0Vout ||
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
      if (i !== 0) continue
      vin.sourceTransaction ??=
        listingBeef.findTxid(String(vin.sourceTXID))?.tx ??
        beef.findTxid(String(vin.sourceTXID))?.tx
      const sourceOut = vin.sourceTransaction?.outputs[vin.sourceOutputIndex]
      const satoshis = sourceOut?.satoshis
      const lockingScript = sourceOut?.lockingScript
      if (typeof satoshis !== 'number' || !lockingScript) {
        throw new Error('Listing input is missing its source locking script')
      }
      // 1sat tips are prefix ‖ P2PKH. getUnlockP2PKH hashes bare P2PKH
      // and fails CHECKSIG ("top stack element must be truthy").
      vin.unlockingScriptTemplate = new P2PKH().unlock(
        await tipSigningKey(active, lockingScript.toHex()),
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
    mark(`signed ${signedTxid.slice(0, 12)}`)
    // The signed cheque is the promise. Registration seals inputs and stores
    // the durable retry body; miners are contacted in the background, the same
    // as cancel and every other signed send. Waiting for Arcade here held the
    // advert 5s per listing, and a late hard-reject already rewrites the row
    // through reportLateMinerSubmitFailure.
    const { registerSignedSend, startSignedSendPropagation } = await import(
      './signedSendLifecycle'
    )
    const signedListing = await registerSignedSend({
      txid,
      atomicBeef: atomic,
      flow: 'market_listing',
    })
    mark('cheque registered')
    chart.send({ type: 'BROADCASTED', txid })
    startSignedSendPropagation(signedListing)
    const listedOutpoint = `${txid}_0`
    const offerOutpoint = `${txid}_1`
    const advert: MarketListingAdvert = {
      outpoint: listedOutpoint,
      offerOutpoint,
      offerLockingScript,
      assetType: listedAsset,
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
        assetType: listedAsset,
        itemLockingScript,
        offerLockingScript,
        payTo: fields.payTo,
        priceSats,
        feePayToAddress: fields.feePayTo,
        privateKey: offerKey,
      })
      mark('settlement unlocks pre-signed')
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
      sellerKeys: seller.keys,
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
    mark('done — advert ready to publish')
    scheduleHistoryBackupPush('market-list')
    rememberGhostTx(txid)
    const identity = listedActivityIdentity({
      inputOutpoint: listingOutpoint,
      origin,
      listedAsset,
      customName: typeof custom.name === 'string' ? custom.name : undefined,
      tags: output.tags,
    })
    // Listing replaces the held tip with txid.0. Paint that replacement now;
    // a market attempt or an unavailable indexer must never make owned assets
    // disappear while listOutputs catches up.
    void import('./collectables').then(({ noteIngestedItem }) => {
      noteIngestedItem({
        outpoint: listedOutpoint.replace('_', '.'),
        chain: active.chain,
        origin,
        name: identity.name,
        app: identity.app,
      })
    })
    const listedNote = `Listed ${identity.name} for ${priceSats.toLocaleString()} sats`
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
      },
    })
    return {
      listing: advert,
      provenance,
      txid,
      beef: listingAdvertBeef(atomic, listingBeef, txid),
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
          name: 'Collectable',
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
        name: 'Collectable',
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
  const fail = (reason: string) => ({ verified: false, reason })
  if (advert.assetType && advert.assetType !== 'ordinal') return fail('MARKET_ASSET_UNSUPPORTED')
  const provenance = parseProvenanceV2(args.provenance)
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
  const active = getActiveWallet()
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
    signature: recordSignatureHex(
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
  buyerAddress?: string
}): MarketSettlementReceipt {
  const active = getActiveWallet()
  if (!active) throw new MarketListingError('WALLET_LOCKED', 'Wallet locked')
  if (
    active.identityKey.toLowerCase() !== args.intent.seller.toLowerCase() ||
    !isMarketPayoutIndexPair(args.sellerOutputIndex, args.feeOutputIndex)
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
    ...(args.buyerAddress ? { buyerAddress: args.buyerAddress } : {}),
  }
  return {
    ...unsigned,
    signature: recordSignatureHex(
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
 * List-time seller signatures in the layout `marketSettlementShape` fixes:
 * the item over the seller payment, the offer over the market fee, both
 * SINGLE|ANYONECANPAY. Publish fails closed when this cannot be built.
 */
export async function buildMarketSettlementUnlocks(args: {
  listingTx: Transaction
  txid: string
  assetType: MarketAssetType
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
  const shape = marketSettlementShape(args.assetType)
  const amounts = calculateMarketSettlement(args.priceSats)
  // The item binds the seller payment and the advert deposit binds the fee;
  // each output sits at its signer's vin.
  const unlocks = await signSellerInputs({
    privateKey: args.privateKey,
    inputs: [
      {
        vin: shape.itemVin,
        sourceTXID: txid,
        sourceOutputIndex: MARKET_ITEM_VOUT,
        sourceTransaction: args.listingTx,
        sourceSatoshis: 1,
        lockingScript: args.itemLockingScript,
        bound: { satoshis: amounts.sellerSats, lockingScript: new P2PKH().lock(args.payTo).toHex() },
      },
      {
        vin: shape.offerVin,
        sourceTXID: txid,
        sourceOutputIndex: MARKET_OFFER_VOUT,
        sourceTransaction: args.listingTx,
        sourceSatoshis: MARKET_OFFER_DEPOSIT_SATS,
        lockingScript: args.offerLockingScript,
        bound: {
          satoshis: amounts.feeSats,
          lockingScript: new P2PKH().lock(args.feePayToAddress).toHex(),
        },
        checksigOnly: true,
      },
    ],
  })
  return {
    version: MARKET_SETTLEMENT_VERSION,
    layout: shape.layout,
    itemUnlockingScript: unlocks[shape.itemVin]!,
    offerUnlockingScript: unlocks[shape.offerVin]!,
    itemSighash: SELLER_SIGHASH,
    offerSighash: SELLER_SIGHASH,
    sellerSats: amounts.sellerSats,
    feeSats: amounts.feeSats,
  }
}

/** Offer lock is <pubkey> OP_CHECKSIG + PushDrop fields. Unlock is sig-only. */
export function checksigOnlyUnlock(
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
    note: 'Cancelled listing',
    ...(args.txid ? { txid: args.txid } : {}),
    item: listed
      ? {
          name: 'Collectable',
          origin: listed.origin,
          outpoint: listed.outpoint,
        }
      : undefined,
  })
  return cancelled
}

/** The listed output's remittance without `market-held`, else rebuilt from the advert. */
async function listedItemRemittance(
  active: ActiveWallet,
  listing: MarketListingAdvert,
): Promise<{ basket: string; tags: string[]; customInstructions: string }> {
  const point = normalizeOutpoint(listing.outpoint)
  {
    try {
      const page = await active.wallet.listOutputs({
        basket: ITEM_STORAGE_BASKET,
        tags: ['market-held'],
        includeCustomInstructions: true,
        includeTags: true,
        limit: 200,
        seekPermission: false,
      })
      const held = page.outputs.find((o) => normalizeOutpoint(o.outpoint) === point)
      if (held?.customInstructions) {
        return {
          basket: ITEM_STORAGE_BASKET,
          tags: (held.tags ?? []).filter((tag) => tag !== 'market-held'),
          customInstructions: held.customInstructions,
        }
      }
    } catch {
      // Rebuilt from the advert below: it names the origin.
    }
  }
  const provenance = getRememberedProvenanceRemittance(point)
  return buildMarketHeldRemittance({
    assetType: 'ordinal',
    origin: listing.origin,
    ...(provenance && 'origin' in provenance ? { provenance } : {}),
  })
}

/** Point local inventory at the returned item; listOutputs stays the truth. */
async function repaintReturnedItem(
  active: ActiveWallet,
  listing: MarketListingAdvert,
  returnedOutpoint: string,
): Promise<void> {
  try {
    const { noteIngestedItem, retireCollectableAfterSpend } = await import('./collectables')
    retireCollectableAfterSpend(listing.outpoint, returnedOutpoint.slice(0, 64))
    noteIngestedItem({
      outpoint: returnedOutpoint,
      chain: active.chain,
      origin: listing.origin,
      identityKey: active.identityKey,
    })
  } catch (err) {
    console.warn(
      '[market] returned item repaint deferred',
      err instanceof Error ? err.message : String(err),
    )
  }
}

const MARKET_CANCEL_RETURN_REFUSAL: Record<Extract<MarketCancelReturn, { kind: 'refuse' }>['reason'], string> = {
  'no-listed-lock': 'The listing transaction does not hold the listed output, so it cannot be cancelled here.',
  'asset-mismatch': 'This listing holds a token, not an item, so it cannot be returned here. Nothing was spent.',
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
  const inBasket = held.outputs.some(
    (output) => normalizeOutpoint(output.outpoint) === normalizeOutpoint(listing.offerOutpoint)
  )
  const offerTxid = listing.offerOutpoint.slice(0, 64).toLowerCase()
  const neverSent = signedListingNeverSent(offerTxid)
  const offerHeld = !neverSent && (inBasket || signedListingCarriesOffer(listing))
  if (!inBasket && offerHeld) {
    console.info(
      `[market] cancel offer ${listing.offerOutpoint.slice(0, 18)}… missing from market-offers — proven by its signed listing`,
    )
  }
  const path = chooseMarketCancelPath({
    offerOutpoint: listing.offerOutpoint,
    neverSent,
    held: offerHeld,
    valid,
    active: current.state === 'active',
  })
  if (path.path === 'refuse' && path.reason === 'listing-never-sent') {
    markMarketListingNeverSent({ txid: offerTxid, reason: 'Listing never reached the network' })
    throw new MarketListingError(
      'MARKET_CANCEL_REFUSED',
      'This listing never reached the network, so there is nothing to cancel — the item is still in your wallet.',
    )
  }
  if (path.path === 'refuse') {
    throw new MarketListingError('MARKET_CANCEL_REFUSED', path.reason)
  }
  const chart = createActor(offerMachine).start()
  chart.send({ type: 'CANCEL', venue: 'market', path })
  let reference: string | null = null
  try {
    // The item is spent too: its list-time signature stays valid for as long
    // as the listed output does, so a cancel that left it would leave the sale
    // open to anyone holding the advert.
    // This wallet signed the listing, so its own copy comes first: a listing
    // that has not been mined has no proof yet, and cancelling it must not wait for one.
    const listingBeef =
      (await getLocalBeefForTxid(active, offerTxid).catch(() => null)) ??
      (await getBeefForTxidCached(active, offerTxid, { needProof: true, allowUnprovenRawTx: true }))
    const listingTx = listingBeef.findTxid(offerTxid)?.tx
    const itemTxid = normalizeOutpoint(listing.outpoint).split(/[._]/)[0]
    const listedLock = listingTx?.outputs[MARKET_ITEM_VOUT]?.lockingScript
    if (itemTxid !== offerTxid || !listingTx || !listedLock) {
      throw new Error('Cancellation needs the listing transaction that holds item and offer')
    }
    const back = chooseMarketCancelReturn({ listedLockHex: listedLock.toHex() })
    console.info(`[market] cancel ${listing.offerOutpoint.slice(0, 18)}… return=${back.kind}${back.kind === 'refuse' ? ` ${back.reason}` : ''}`)
    if (back.kind === 'refuse') {
      throw new MarketListingError('MARKET_CANCEL_REFUSED', MARKET_CANCEL_RETURN_REFUSAL[back.reason])
    }
    // The offer input signs ALL, which is what lets the index accept a return
    // to a fresh child rather than the listing's payout lock.
    const returnKey = selfTokenOutput(active)
    rememberTipKey(active, returnKey.key)
    const returnLock = new P2PKH().lock(returnKey.address).toHex()
    const listedRemittance = await listedItemRemittance(active, listing)
    const heldRemittance = { ...listedRemittance, ...heldItemRow(listedRemittance, returnKey.remittance) }
    const created = await active.wallet.createAction({
      description: 'Cancel BRC-48 market offer',
      labels: ['market-v3', 'brc48', 'market-cancel'],
      inputBEEF: listingBeef.toBinary(),
      inputs: [
        {
          outpoint: normalizeOutpoint(listing.outpoint).replace('_', '.'),
          inputDescription: 'Listed market item returning',
          unlockingScriptLength: 108,
        },
        {
          outpoint: normalizeOutpoint(listing.offerOutpoint).replace('_', '.'),
          inputDescription: 'Cancelled market offer',
          unlockingScriptLength: 73,
        },
      ],
      outputs: [
        {
          lockingScript: returnLock,
          satoshis: 1,
          outputDescription: 'Market item returned',
          ...heldRemittance,
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
      tx.inputs[0]?.sourceOutputIndex !== MARKET_ITEM_VOUT ||
      String(tx.inputs[1]?.sourceTXID).toLowerCase() !== offerTxid ||
      tx.inputs[1]?.sourceOutputIndex !== MARKET_OFFER_VOUT ||
      tx.outputs[0]?.satoshis !== 1 ||
      tx.outputs[0]?.lockingScript?.toHex() !== returnLock
    ) {
      throw new Error('Cancellation must spend item then offer and return the item at output zero')
    }
    const key = marketListingKey(active, current.sellerKeys)
    const spends: Record<number, { unlockingScript: string }> = {}
    for (const vin of [0, 1]) {
      const input = tx.inputs[vin]!
      input.sourceTransaction ??= beef.findTxid(String(input.sourceTXID))?.tx ?? listingTx
      const sourceOut = input.sourceTransaction?.outputs[input.sourceOutputIndex]
      const satoshis = sourceOut?.satoshis
      const lockingScript = sourceOut?.lockingScript
      if (typeof satoshis !== 'number' || !lockingScript) {
        throw new Error('Cancel input is missing its source locking script')
      }
      const template =
        vin === 0
          ? new P2PKH().unlock(
              current.sellerKeys ? key : await tipSigningKey(active, lockingScript.toHex()),
              'all',
              false,
              satoshis,
              lockingScript,
            )
          : checksigOnlyUnlock(key, satoshis, lockingScript)
      const unlockingScript = (await template.sign(tx, vin)).toHex()
      if (!unlockingScript) throw new Error('Cancellation signature missing')
      spends[vin] = { unlockingScript }
    }
    chart.send({ type: 'SIGNED_UNKNOWN' })
    // The listing may still be queued for miners; the signed send outbox
    // propagates the cancel after it, never an inline broadcast.
    const signed = await active.wallet.signAction({
      reference,
      spends,
      options: { noSend: true },
    })
    const txid = signed.txid?.toLowerCase() ?? ''
    const beefBytes = signed.tx ? Array.from(signed.tx) : []
    if (!/^[0-9a-f]{64}$/.test(txid) || beefBytes.length === 0) {
      chart.send({ type: 'RECOVER' })
      throw new Error('Cancellation broadcast result is unknown')
    }
    const { registerSignedSend, propagateSignedSend } = await import(
      './signedSendLifecycle'
    )
    const signedCancel = await registerSignedSend({
      txid,
      atomicBeef: beefBytes,
      flow: 'market_cancel',
    })
    chart.send({ type: 'BROADCASTED', txid })
    markMarketListingCancelled({
      outpoint: current.outpoint,
      nonce: current.nonce,
      txid,
    })
    chart.send({ type: 'COMMITTED' })
    // The returned asset counts once the cancel leaves `nosend`; a caller that
    // reads its balance on return must see it whenever the network took it.
    const submitted = await propagateSignedSend(signedCancel).catch(() => null)
    if (submitted?.kind === 'accepted') {
      const { pinBroadcastLocalTx } = await import('./staleOutputRelease')
      await pinBroadcastLocalTx(txid, beefBytes).catch(() => false)
    }
    await repaintReturnedItem(active, listing, `${txid}.0`)
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
  /**
   * Legacy two-call clients may still supply a buyer-signed intent. New clients
   * omit it: the wallet verifies the listing, signs the intent, and settles in
   * this one permissioned request.
   */
  intent?: MarketPurchaseIntent
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
  const intent =
    args.intent ??
    (await createMarketPurchaseIntent({
      listing: args.listing,
      provenance: args.provenance,
    }))
  return executeMarketPurchase({ ...args, intent })
}

export async function getMarketSettlementReceipt(args: {
  intent: MarketPurchaseIntent
}): Promise<MarketSettlementReceipt | null> {
  const { recoverMarketSettlementReceipt } = await import('./marketSettlement')
  return recoverMarketSettlementReceipt(args)
}


/** Live listing mark for the seller's inventory, or null when not listed. */
export function marketListingMark(
  auth: MarketListingAuthorization | null | undefined,
): MarketListingMark | null {
  if (!auth || (auth.state !== 'active' && auth.state !== 'reserved')) return null
  if (!(auth.priceSats > 0)) return null
  return auth.publish?.kind === 'unpublished'
    ? { kind: 'unpublished', priceSats: auth.priceSats, reason: auth.publish.reason }
    : { kind: 'listed', priceSats: auth.priceSats }
}

function authorizationForListingTxid(
  txid: string | undefined,
): MarketListingAuthorization | null {
  const id = txid?.trim().toLowerCase()
  if (!id || !/^[0-9a-f]{64}$/.test(id)) return null
  return (
    listMarketListingAuthorizations()
      .filter((row) => normalizeOutpoint(row.outpoint) === normalizeOutpoint(`${id}_0`))
      .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
  )
}

function setMarketListingPublish(
  auth: MarketListingAuthorization,
  publish: MarketPublishState,
): void {
  saveAuthorization({ ...auth, publish, updatedAt: Date.now() })
}

/**
 * The app could not put a signed listing on the index. The offer is already
 * on chain (the cheque registered before the advert returned), so the listing
 * is not failed: it is unpublished, and stays cancellable or re-publishable.
 */
export function markMarketListingPublishFailed(args: {
  txid?: string
  reason?: string
}): void {
  const reason = args.reason?.trim() || 'Could not publish listing'
  // The overlay's refusal code only reaches this device through the app's
  // report. Log it so triage can name the fix without anyone reading a log.
  console.warn(
    `[market-list] publish failed txid=${args.txid?.trim().toLowerCase() ?? '?'} reason=${reason.slice(0, 160)}`,
  )
  const auth = authorizationForListingTxid(args.txid)
  if (!auth) {
    failMarketListingActivity({ txid: args.txid, reason })
    return
  }
  setMarketListingPublish(auth, { kind: 'unpublished', reason: reason.slice(0, 160), at: Date.now() })
  noteMarketListingUnpublished({ txid: args.txid, reason })
}

/** No miner will take this signed listing: it was refused here or rejected. */
function signedListingNeverSent(txid: string): boolean {
  return getTxByTxid(txid)?.status === 'FAILED_REJECTED'
}

/**
 * A signed listing that no miner took put no offer on chain, so the item
 * never left. Retire the auth so no surface offers Cancel or re-publish.
 */
export function markMarketListingNeverSent(args: { txid?: string; reason: string }): boolean {
  const auth = authorizationForListingTxid(args.txid)
  if (!auth || (auth.state !== 'active' && auth.state !== 'reserved')) return false
  updateMarketListingAuthorization({
    outpoint: auth.outpoint,
    nonce: auth.nonce,
    from: ['active', 'reserved'],
    to: 'failed',
    reason: 'never-sent',
  })
  failMarketListingActivity({ txid: args.txid, reason: args.reason })
  console.warn(
    `[market-list] never sent txid=${args.txid?.trim().toLowerCase()} — listing retired, item kept`,
  )
  return true
}

/** The index accepted this listing (first publish or a re-publish). */
export function markMarketListingPublished(args: { txid?: string }): { ok: boolean } {
  const auth = authorizationForListingTxid(args.txid)
  if (!auth) return { ok: false }
  if (auth.publish?.kind === 'unpublished') {
    console.info(`[market-list] republished txid=${args.txid?.trim().toLowerCase()}`)
  }
  setMarketListingPublish(auth, { kind: 'published', at: Date.now() })
  noteMarketListingPublished({ txid: args.txid })
  return { ok: true }
}

/**
 * The listing's own signed cheque proves its offer output when the basket
 * read misses it (store rebuilt under a new user row, or a read that raced
 * the commit). Without it a just-signed listing could not be cancelled.
 */
function signedListingCarriesOffer(listing: MarketListingAdvert): boolean {
  const offerTxid = listing.offerOutpoint.slice(0, 64).toLowerCase()
  const atomic = signedChequeAtomic(offerTxid)
  if (!atomic?.length) return false
  try {
    const out = Beef.fromBinary(atomic).findTxid(offerTxid)?.tx?.outputs[MARKET_OFFER_VOUT]
    return (
      out?.satoshis === MARKET_OFFER_DEPOSIT_SATS &&
      out.lockingScript?.toHex() === listing.offerLockingScript
    )
  } catch {
    return false
  }
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
