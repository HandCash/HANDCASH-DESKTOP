import {
  Beef,
  BigNumber,
  Hash,
  P2PKH,
  PrivateKey,
  PublicKey,
  Signature,
  Utils,
} from '@bsv/sdk'
import { SetupClient } from '@bsv/wallet-toolbox-client'
import { createActor } from 'xstate'
import { marketListingMachine, mayAbortMarketListing } from '../machines/marketListingMachine'
import { normalizeAppHost } from './appIdentity'
import { getActiveWallet } from './session'
import { durableGetItem, durableSetItem } from './durableStorage'
import {
  buildCollectableCustomInstructions,
  parseProvenanceV2,
  tryBuildProvenanceV2,
  verifyProvenanceForHeldTip,
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
import { scheduleHistoryBackupPush } from './deviceSync'
import {
  encodeMarketOffer,
  MARKET_ITEM_VOUT,
  MARKET_OFFER_DEPOSIT_SATS,
  MARKET_OFFER_VOUT,
  normalizeMarketOfferFields,
  parseMarketOffer,
  type MarketOfferFields,
} from './marketOverlayProtocol'
import {
  chooseMarketCancelPath,
  chooseMarketListingPath,
} from './marketListingPath'
import { defaultMessageboxBase } from './messageTransport'

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
  assetType: 'ordinal'
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
}

export type CreateMarketListingArgs = {
  outpoint: string
  assetType?: 'ordinal'
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
  if ((args as { assetType?: string }).assetType === 'bsv21') {
    throw new MarketListingError(
      'MARKET_ASSET_UNSUPPORTED',
      'Market overlay v1 supports one-sat ordinal collectables only.'
    )
  }
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
    messagebox: args.messagebox?.trim() || defaultMessageboxBase(),
  })
  const offerLockingScript = encodeMarketOffer(fields)
  const itemLockingScript = new P2PKH().lock(active.address).toHex()
  const path = chooseMarketListingPath({
    itemOutpoint: outpoint,
    satoshis: output.satoshis ?? 0,
    ordinal: (output.tags ?? []).some((tag) => tag.toLowerCase() === 'ordinal'),
    provenanceProven: true,
    termsValid: true,
  })
  if (path.path === 'refuse') {
    throw new MarketListingError('MARKET_LISTING_REFUSED', path.reason)
  }
  const chart = createActor(marketListingMachine).start()
  chart.send({ type: 'LIST', path })
  const itemTxid = outpoint.slice(0, 64)
  const inputBEEF = (await getBeefForTxidCached(active, itemTxid)).toBinary()
  let reference: string | null = null
  try {
    const created = await active.wallet.createAction({
      description: 'Create 1Sat market offer',
      labels: ['market-v3', 'brc48', 'brc147', 'brc150', 'brc159'],
      inputBEEF,
      inputs: [
        {
          outpoint: outpoint.replace('_', '.'),
          inputDescription: 'Market item input zero',
          unlockingScriptLength: 108,
        },
      ],
      outputs: [
        {
          lockingScript: itemLockingScript,
          satoshis: 1,
          outputDescription: 'Held market item',
          basket: '1sat',
          tags: [
            'ordinal',
            'market-held',
            `origin:${origin.replace('_', '.')}`,
          ],
          customInstructions: buildCollectableCustomInstructions({
            origin,
            name:
              typeof custom.name === 'string' && custom.name.trim()
                ? custom.name.trim()
                : 'Market item',
            provenance,
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
      ],
      options: {
        randomizeOutputs: false,
        signAndProcess: false,
        trustSelf: 'known',
      },
    })
    const signable = created.signableTransaction
    if (!signable) throw new Error('Market listing did not return a signable action')
    reference = signable.reference
    chart.send({ type: 'STAGED', reference })
    const beef = Beef.fromBinary(signable.tx)
    const tx = beef.txs.find((entry) =>
      entry.tx?.inputs.some(
        (input) =>
          String(input.sourceTXID).toLowerCase() === itemTxid &&
          input.sourceOutputIndex === Number(outpoint.split('_')[1])
      )
    )?.tx
    if (!tx) throw new Error('Market listing transaction is missing item input')
    if (
      String(tx.inputs[0]?.sourceTXID).toLowerCase() !== itemTxid ||
      tx.inputs[0]?.sourceOutputIndex !== Number(outpoint.split('_')[1]) ||
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
    tx.inputs[0]!.unlockingScriptTemplate = SetupClient.getUnlockP2PKH(
      PrivateKey.fromHex(active.rootKeyHex),
      1
    )
    await tx.sign()
    const unlockingScript = tx.inputs[0]?.unlockingScript?.toHex()
    if (!unlockingScript) throw new Error('Market item signature missing')
    chart.send({ type: 'SIGNED_UNKNOWN' })
    const signed = await active.wallet.signAction({
      reference,
      spends: { 0: { unlockingScript } },
      options: { acceptDelayedBroadcast: false },
    })
    const txid = signed.txid?.toLowerCase() ?? ''
    const atomic = signed.tx ? Array.from(signed.tx) : []
    if (!/^[0-9a-f]{64}$/.test(txid) || atomic.length === 0) {
      chart.send({ type: 'RECOVER' })
      throw new MarketListingError(
        'MARKET_LISTING_BROADCAST_UNKNOWN',
        'Listing was signed but wallet processing did not return a transaction.'
      )
    }
    chart.send({ type: 'BROADCASTED', txid })
    const listedOutpoint = `${txid}_0`
    const offerOutpoint = `${txid}_1`
    const advert: MarketListingAdvert = {
      outpoint: listedOutpoint,
      offerOutpoint,
      offerLockingScript,
      assetType: 'ordinal',
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
    chart.send({ type: 'COMMITTED' })
    scheduleHistoryBackupPush('market-list')
    recordWalletEvent({
      method: 'market-list',
      note: `Listed collectable for ${priceSats.toLocaleString()} sats`,
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
    if (reference && mayAbortMarketListing(chart.getSnapshot())) {
      await active.wallet.abortAction({ reference }).catch(() => {})
      chart.send({
        type: 'ABORTED',
        error: err instanceof Error ? err.message : String(err),
      })
    } else {
      chart.send({
        type: 'FAIL',
        error: err instanceof Error ? err.message : String(err),
      })
    }
    throw err
  } finally {
    chart.stop()
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
  const verified = await verifyProvenanceForHeldTip({
    provenance,
    heldOutpoint: outpoint,
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

function markMarketListingCancelled(args: {
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

export async function createCancelMarketListingAdvert(args: {
  outpoint: string
  nonce?: string
}): Promise<MarketCancelAdvert> {
  const current = getMarketListingAuthorization(args)
  if (!current) {
    throw new MarketListingError('LISTING_NOT_AUTHORIZED', 'Listing not found.')
  }
  const active = getActiveWallet()
  if (!active) throw new MarketListingError('WALLET_LOCKED', 'Wallet locked')
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
    const inputBEEF = (await getBeefForTxidCached(active, offerTxid)).toBinary()
    const created = await active.wallet.createAction({
      description: 'Cancel BRC-48 market offer',
      labels: ['market-v3', 'brc48', 'market-cancel'],
      inputBEEF,
      inputs: [
        {
          outpoint: listing.offerOutpoint.replace('_', '.'),
          inputDescription: 'Cancelled market offer',
          unlockingScriptLength: 108,
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
    tx.inputs[0]!.unlockingScriptTemplate = SetupClient.getUnlockP2PKH(
      PrivateKey.fromHex(active.rootKeyHex),
      MARKET_OFFER_DEPOSIT_SATS
    )
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
    if (reference && mayAbortMarketListing(chart.getSnapshot())) {
      await active.wallet.abortAction({ reference }).catch(() => {})
      chart.send({
        type: 'ABORTED',
        error: err instanceof Error ? err.message : String(err),
      })
    } else {
      chart.send({
        type: 'FAIL',
        error: err instanceof Error ? err.message : String(err),
      })
    }
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
