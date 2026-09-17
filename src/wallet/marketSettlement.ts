import {
  Beef,
  Hash,
  P2PKH,
  PrivateKey,
  PublicKey,
  Transaction,
  Utils,
} from '@bsv/sdk'
import { SetupClient } from '@bsv/wallet-toolbox-client'
import { createActor } from 'xstate'
import {
  marketPurchaseMachine,
  mayAbortMarketPurchase,
} from '../machines/marketPurchaseMachine'
import { marketSellerSettlementMachine } from '../machines/marketSellerSettlementMachine'
import { getBeefForTxidCached, rememberBeefBinary } from './beefCache'
import {
  adoptMarketSaleReceipt,
  buildMarketHeldRemittance,
  calculateMarketSettlement,
  createMarketSettlementReceipt,
  findMarketListingAuthorizationBySaleId,
  listMarketListingAuthorizations,
  getMarketListingAuthorization,
  marketFeePayToAddress,
  markMarketSettlementProgress,
  MarketListingError,
  reserveMarketListingAuthorization,
  updateMarketListingAuthorization,
  verifyMarketPurchaseIntent,
  verifyMarketListingProvenance,
  verifyMarketSettlementReceipt,
  type MarketListingAdvert,
  type MarketListingAuthorization,
  type MarketPurchaseIntent,
  type MarketSettlementReceipt,
  type PurchaseMarketListingArgs,
} from './marketListing'
import {
  chooseMarketReceiptAuthority,
  marketReceiptRefusalIsTerminal,
  verifyMarketSettlementPayout,
  type MarketReceiptRefusal,
} from './marketReceiptAuthority'
import {
  extendProvenanceV2,
  parseProvenanceV2,
  rememberProvenLineage,
} from './oneSatProvenance'
import { rememberProvenVerdict } from './provenCache'
import {
  clearAwaitingVerification,
  clearVerificationProgress,
} from './verificationProgress'
import { buildBsv21ValueLock, decodeBsv21Binary } from './token'
import {
  MARKET_ITEM_VOUT,
  MARKET_OFFER_DEPOSIT_SATS,
  parseMarketOffer,
} from './marketOverlayProtocol'
import { bumpBalanceAfterHeal, getActiveWallet } from './session'
import { broadcastAtomicBeef } from './sendBrc29Payment'
import {
  decodeBeefB64,
  deliverMarketSettlementWire,
  pollInboundTipHints,
  publicMessageboxBase,
  type MarketSettlementWire,
} from './messageTransport'
import { durableGetItem, durableSetItem } from './durableStorage'
import { createDurableTtlTxidMap } from './durableTtlTxidMap'
import {
  describeInsufficientFunds,
  isInsufficientFundsError,
} from './insufficientFunds'
import { runExclusiveSpend } from './spendGuard'
import {
  choosePendingMarketReceiptPath,
  chooseMarketReceiptBroadcastPath,
  chooseMarketReceiptDeliveryPath,
  type MarketReceiptDeliveryPath,
} from './marketSettlementPath'
import { clearSoldListingFromMarket } from './marketSoldAnnounce'
import { scheduleHistoryBackupPush } from './deviceSync'
import { recordAppActivity, WALLET_ACTIVITY_ORIGIN } from './appActivity'
import { addressFromIdentityKey } from './friends'
import { sweepVisibleP2pkhOutpoints } from './importP2pkhFunding'
import { getResolvedInscription } from './inscriptionCache'
import {
  DEFAULT_BRC_CLOUD_BASE_URL,
  PUBLIC_BRC_CLOUD_ORIGIN,
} from './walletConfig'

const PENDING_KEY = 'handcash.market.pending.v2'
const RESPONSE_KEY = 'handcash.market.responses.v2'
/**
 * List-time `settlementUnlocks` are the purchase path. Live seller sign is
 * not required: messagebox is store-and-forward for remittance after pay.
 */
const SETTLEMENT_TIMEOUT_MS = 30_000
const LISTING_DETAIL_MS = 4_000
/** Normal Arcade accepts land in under 4s; slower propagation belongs in outbox. */
const MARKET_BROADCAST_WAIT_MS = 5_000

/**
 * What happened to the seller's copy of a committed settlement.
 *
 * `boxAccepted` is the case messagebox exists for: BRC-33 store-and-forward now
 * holds the receipt, so the seller may be offline indefinitely and there is
 * nothing left to chase. The other two are the cases it cannot cover — a box
 * that never accepted the message stored nothing, and a local seller has no box
 * hop at all.
 */
type SellerHandoffOutcome =
  | { handoff: 'boxAccepted' }
  | { handoff: 'boxUnreachable'; reason: string }
  | { handoff: 'localSweepDeferred' }

async function sellerHandoffOutcome(
  receiptPath: MarketReceiptDeliveryPath,
  receiptWire: Parameters<typeof deliverMarketSettlementWire>[0],
): Promise<SellerHandoffOutcome> {
  if (receiptPath.path === 'localSellerReconcile') {
    return { handoff: 'localSweepDeferred' }
  }
  try {
    const delivered = await deliverMarketSettlementWire(receiptWire)
    return delivered
      ? { handoff: 'boxAccepted' }
      : { handoff: 'boxUnreachable', reason: 'not accepted by box' }
  } catch (err) {
    return {
      handoff: 'boxUnreachable',
      reason: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Hand the signed settlement to miner propagation without making the purchase
 * UI wait indefinitely for provider acknowledgement. `broadcastAtomicBeef`
 * durably queues before posting, and continues handling a late hard rejection.
 */
async function submitMarketSettlement(
  txid: string,
  atomic: number[],
): Promise<boolean> {
  const pending = broadcastAtomicBeef(txid, atomic)
  let timer: ReturnType<typeof setTimeout> | undefined
  const outcome = await Promise.race([
    pending.then((accepted) => ({ kind: 'answered' as const, accepted })),
    new Promise<{ kind: 'queued'; accepted: true }>((resolve) => {
      timer = setTimeout(
        () => resolve({ kind: 'queued', accepted: true }),
        MARKET_BROADCAST_WAIT_MS,
      )
    }),
  ])
  if (timer) clearTimeout(timer)
  if (outcome.kind === 'queued') {
    console.info(
      `[market-buy] miner acknowledgement still pending after ${MARKET_BROADCAST_WAIT_MS}ms — propagation queued`,
    )
    void pending.then((accepted) => {
      if (!accepted) {
        console.warn('[market-buy] queued settlement was later rejected', txid)
      }
    })
  }
  return outcome.accepted
}

/**
 * The listing proof already established old-tip → origin and the signed
 * settlement proves new-tip → old-tip. Extend that known proof locally instead
 * of launching indexer walks against a transaction that just entered mempool.
 */
async function provePurchasedMarketTip(args: {
  active: NonNullable<ReturnType<typeof getActiveWallet>>
  provenance: NonNullable<ReturnType<typeof parseProvenanceV2>>
  outpoint: string
  atomic: number[]
}): Promise<boolean> {
  const extended = await extendProvenanceV2({
    prior: args.provenance,
    heldOutpoint: args.outpoint,
    tipBeef: args.atomic,
    getBeef: (txid) =>
      getBeefForTxidCached(args.active, txid, {
        needProof: true,
        allowUnprovenRawTx: true,
      }),
  })
  if (!extended) return false
  rememberProvenVerdict(args.outpoint, {
    tier: 'brc150',
    origin: extended.origin,
    path: extended.path,
    verifiedAt: Date.now(),
  })
  rememberProvenLineage({
    tipOutpoint: args.outpoint,
    origin: extended.origin,
    path: extended.path,
    beef: Utils.toArray(extended.beefB64, 'base64'),
  })
  clearAwaitingVerification(args.outpoint)
  clearVerificationProgress(args.outpoint)
  return true
}

/**
 * Overlay already stored the listing tx at admit time. Prefer that BEEF over
 * indexer `getBeefForTxid`, which currently times out (8s) and refuses the buy.
 */
export function overlayListingBeefBinary(
  listing: MarketListingAdvert & { listingBeefB64?: string | null },
  itemTxid: string,
): number[] | null {
  const b64 = listing.listingBeefB64?.trim()
  const txid = itemTxid.trim().toLowerCase()
  if (!b64 || !/^[0-9a-f]{64}$/.test(txid)) return null
  try {
    const binary = Utils.toArray(b64, 'base64')
    const beef = Beef.fromBinary(binary)
    if (!beef.findTxid(txid)?.tx) return null
    return beef.toBinary()
  } catch {
    return null
  }
}

function marketCloudOrigin(): string {
  return (DEFAULT_BRC_CLOUD_BASE_URL.trim() || PUBLIC_BRC_CLOUD_ORIGIN).replace(
    /\/+$/,
    '',
  )
}

function listingItemTxid(listing: MarketListingAdvert): string {
  return normalizeOutpoint(listing.outpoint).split('.')[0] ?? ''
}

/** Pull overlay BEEF + list-time unlocks when the buy payload omitted them. */
export async function hydrateMarketListingForPurchase(
  listing: MarketListingAdvert,
): Promise<MarketListingAdvert> {
  const amounts = calculateMarketSettlement(listing.priceSats)
  const hasUnlocks = listingHasBuyerCompletableSettlement(listing, amounts)
  const hasBeef = Boolean(
    overlayListingBeefBinary(listing, listingItemTxid(listing)),
  )
  if (hasUnlocks && hasBeef) return listing
  const outpoint = listing.outpoint?.trim()
  if (!outpoint) return listing
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), LISTING_DETAIL_MS)
  try {
    const res = await fetch(
      `${marketCloudOrigin()}/v1/market/listings/${encodeURIComponent(outpoint)}`,
      { signal: ac.signal, headers: { Accept: 'application/json' } },
    )
    if (!res.ok) return listing
    const body = (await res.json()) as { listing?: Partial<MarketListingAdvert> }
    const detail = body.listing
    if (!detail || typeof detail !== 'object') return listing
    const merged: MarketListingAdvert = {
      ...listing,
      ...detail,
      outpoint: listing.outpoint,
      settlementUnlocks:
        detail.settlementUnlocks ?? listing.settlementUnlocks ?? null,
      listingBeefB64: detail.listingBeefB64 ?? listing.listingBeefB64 ?? null,
    }
    console.info(
      '[market-buy] hydrated listing detail',
      `unlocks=${String(listingHasBuyerCompletableSettlement(merged, amounts))}`,
      `beef=${Boolean(overlayListingBeefBinary(merged, listingItemTxid(merged)))}`,
    )
    return merged
  } catch (err) {
    console.warn(
      '[market-buy] listing detail skipped',
      err instanceof Error ? err.message : String(err),
    )
    return listing
  } finally {
    clearTimeout(timer)
  }
}

type PendingPurchase = {
  saleId: string
  reference: string
  itemVin: number
  offerVin: number
  phase:
    | 'preSignAbortable'
    | 'signedUnknown'
    | 'broadcast'
    | 'committed'
    | 'recovery'
  txid?: string
  atomicBeef?: number[]
  expiresAt: number
  sellerIdentityKey: string
  intent: MarketPurchaseIntent
  sellerMessagebox?: string
}

type StoredResponse = Extract<
  MarketSettlementWire,
  { type: 'sign-response' | 'receipt-response' }
>

function readJson<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(durableGetItem(key) ?? '') as T
  } catch {
    return fallback
  }
}

function writePending(pending: PendingPurchase[]): void {
  durableSetItem(PENDING_KEY, JSON.stringify(pending))
}

function savePending(record: PendingPurchase): void {
  const records = readJson<PendingPurchase[]>(PENDING_KEY, []).filter(
    (item) => item.saleId !== record.saleId
  )
  writePending([...records, record])
}

/** Keep signed txid/BEEF across crash phases — recovery must never wipe them. */
export function mergePendingPurchase(
  previous: PendingPurchase,
  patch: Partial<PendingPurchase>,
): PendingPurchase {
  return {
    ...previous,
    ...patch,
    txid: patch.txid ?? previous.txid,
    atomicBeef: patch.atomicBeef ?? previous.atomicBeef,
  }
}

/** Nosend references that a later send/refresh must not abort. */
export function protectedMarketActionReferences(): Set<string> {
  return new Set(
    readJson<PendingPurchase[]>(PENDING_KEY, [])
      .filter((item) => item.phase !== 'preSignAbortable' || Date.now() < item.expiresAt)
      .map((item) => item.reference)
      .filter(Boolean),
  )
}

function removePending(saleId: string): void {
  writePending(
    readJson<PendingPurchase[]>(PENDING_KEY, []).filter(
      (item) => item.saleId !== saleId
    )
  )
}

function saveResponse(response: StoredResponse): void {
  const responses = readJson<StoredResponse[]>(RESPONSE_KEY, []).filter(
    (item) => item.saleId !== response.saleId
  )
  durableSetItem(RESPONSE_KEY, JSON.stringify([...responses, response]))
}

function takeResponse(
  saleId: string,
  type: StoredResponse['type']
): StoredResponse | null {
  const responses = readJson<StoredResponse[]>(RESPONSE_KEY, [])
  const found =
    responses.find((item) => item.saleId === saleId && item.type === type) ??
    null
  if (found) {
    durableSetItem(
      RESPONSE_KEY,
      JSON.stringify(responses.filter((item) => item.saleId !== saleId))
    )
  }
  return found
}

function b64(bytes: number[] | Uint8Array): string {
  const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes)
  let binary = ''
  for (const byte of data) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function normalizeOutpoint(value: string): string {
  const match = /^([0-9a-f]{64})[._](\d+)$/i.exec(value.trim())
  if (!match) throw new Error('Invalid market item outpoint')
  return `${match[1]!.toLowerCase()}.${Number(match[2])}`
}

function subjectTransaction(
  beef: Beef,
  outpoint: string
): {
  tx: Transaction
  vin: number
} {
  const [txid, voutRaw] = normalizeOutpoint(outpoint).split('.')
  const vout = Number(voutRaw)
  for (const entry of beef.txs ?? []) {
    const tx = entry.tx
    if (!tx) continue
    const vin = tx.inputs.findIndex(
      (input) =>
        String(input.sourceTXID).toLowerCase() === txid &&
        input.sourceOutputIndex === vout
    )
    if (vin >= 0) return { tx, vin }
  }
  throw new Error('Listed item input is missing from settlement transaction')
}

function outputEquals(
  tx: Transaction,
  index: number,
  satoshis: number,
  lockingScript: string
): boolean {
  const output = tx.outputs[index]
  return (
    !!output &&
    output.satoshis === satoshis &&
    output.lockingScript?.toHex().toLowerCase() === lockingScript.toLowerCase()
  )
}

export function marketSettlementCommitment(tx: Transaction): string {
  const shape = JSON.stringify({
    version: tx.version,
    lockTime: tx.lockTime,
    inputs: tx.inputs.map((input) => ({
      txid: String(input.sourceTXID).toLowerCase(),
      vout: input.sourceOutputIndex,
      sequence: input.sequence,
    })),
    outputs: tx.outputs.map((output) => ({
      satoshis: output.satoshis,
      lockingScript: output.lockingScript?.toHex().toLowerCase(),
    })),
  })
  return Utils.toHex(Hash.sha256(Utils.toArray(shape, 'utf8')))
}


/**
 * Additional ordinary BSV outputs are funded entirely by buyer inputs. Toolbox
 * change uses private derived scripts, not the buyer's public identity address,
 * so the seller cannot and need not match its exact lock.
 */
function isBuyerFundedBsvChangeOutput(
  scriptHex: string,
  sats: number | undefined,
): boolean {
  if (!Number.isSafeInteger(sats) || sats == null || sats < 1) return false
  if (!scriptHex) return false
  // Token-like extras remain subject to the buyer/token conservation check.
  return decodeBsv21Binary(scriptHex) == null
}

/** 162 value lock whose remainder P2PKH pays the buyer. */
function isBuyerBsv21ValueLock(
  scriptHex: string,
  buyerP2pkh: string,
  tokenId: string,
): boolean {
  const decoded = decodeBsv21Binary(scriptHex)
  if (!decoded || decoded.role !== 'value' || decoded.amount <= 0n) return false
  if (decoded.restScriptHex !== buyerP2pkh.toLowerCase()) return false
  const origin = tokenId.trim().toLowerCase().replace('.', '_')
  if (decoded.tokenId && decoded.tokenId.toLowerCase() !== origin) return false
  return true
}

export function validateMarketSettlementOutputs(args: {
  tx: Transaction
  beef: Beef
  listing: MarketListingAdvert
  buyerIdentityKey: string
  buyerAddress?: string
  chain: 'main' | 'test'
  itemVin: number
  offerVin: number
  itemOutputIndex: number
  sellerOutputIndex: number
  feeOutputIndex: number
}): void {
  if (args.chain !== 'main') {
    throw new Error('Market settlement is mainnet only')
  }
  const amounts = calculateMarketSettlement(args.listing.priceSats)
  const buyerAddress =
    (args.buyerAddress ?? '').trim() ||
    PublicKey.fromString(args.buyerIdentityKey).toAddress(
      args.chain === 'main' ? 'mainnet' : 'testnet'
    )
  const buyerChangeLock = new P2PKH().lock(buyerAddress).toHex().toLowerCase()
  if (args.listing.assetType === 'bsv21') {
    if (args.listing.amt == null || !(args.listing.amt > 0)) {
      throw new Error('BSV-21 settlement requires a 162 amount')
    }
  }
  const buyerItemLock =
    args.listing.assetType === 'bsv21'
      ? buildBsv21ValueLock({
          tokenId: args.listing.origin,
          amount: BigInt(args.listing.amt!),
          address: buyerAddress,
        })
      : buyerChangeLock
  const sellerLock = new P2PKH().lock(args.listing.payTo).toHex()
  const feeLock = new P2PKH()
    .lock(marketFeePayToAddress(args.listing))
    .toHex()
  const feeOutput = args.tx.outputs[args.feeOutputIndex]
  const itemPoint = normalizeOutpoint(args.listing.outpoint)
  const offerPoint = normalizeOutpoint(args.listing.offerOutpoint)
  const [itemTxid, itemVout] = itemPoint.split('.')
  const [offerTxid, offerVout] = offerPoint.split('.')
  if (
    args.itemVin !== 0 ||
    args.offerVin !== 1 ||
    args.itemOutputIndex !== MARKET_ITEM_VOUT ||
    args.sellerOutputIndex !== 1 ||
    args.feeOutputIndex !== 2 ||
    String(args.tx.inputs[0]?.sourceTXID).toLowerCase() !== itemTxid ||
    args.tx.inputs[0]?.sourceOutputIndex !== Number(itemVout) ||
    String(args.tx.inputs[1]?.sourceTXID).toLowerCase() !== offerTxid ||
    args.tx.inputs[1]?.sourceOutputIndex !== Number(offerVout)
  ) {
    throw new Error('Settlement item/offer input or output ordering is invalid')
  }
  const itemSource =
    args.tx.inputs[0]?.sourceTransaction ?? args.beef.findTxid(itemTxid!)?.tx
  const offerSource =
    args.tx.inputs[1]?.sourceTransaction ?? args.beef.findTxid(offerTxid!)?.tx
  const itemSourceOutput = itemSource?.outputs[Number(itemVout)]
  const offerSourceOutput = offerSource?.outputs[Number(offerVout)]
  if (itemSourceOutput?.satoshis !== 1 || offerSourceOutput?.satoshis !== 1) {
    throw new Error('Settlement seller inputs must each be one satoshi')
  }
  const offer = parseMarketOffer(offerSourceOutput.lockingScript?.toHex() ?? '')
  if (
    offerSourceOutput.lockingScript?.toHex().toLowerCase() !==
      args.listing.offerLockingScript.toLowerCase() ||
    offer.nonce !== args.listing.nonce ||
    offer.grossPriceSats !== args.listing.priceSats ||
    offer.exactFeeSats !== args.listing.exactFeeSats ||
    offer.depositSats !== MARKET_OFFER_DEPOSIT_SATS ||
    (offer.expiresAt != null && offer.expiresAt <= Date.now())
  ) {
    throw new Error('Settlement offer token does not match active terms')
  }
  if (
    !outputEquals(args.tx, args.itemOutputIndex, 1, buyerItemLock) ||
    !outputEquals(
      args.tx,
      args.sellerOutputIndex,
      amounts.sellerSats,
      sellerLock
    ) ||
    !feeOutput ||
    feeOutput.satoshis !== amounts.feeSats ||
    feeOutput.lockingScript?.toHex().toLowerCase() !==
      feeLock.toLowerCase()
  ) {
    throw new Error('Settlement outputs do not match listing terms')
  }
  // Extra outputs after the market fee are optional. Zero extra is valid
  // (exact BSV funds, no change). Ordinary BSV change may use any wallet-derived
  // lock because it is funded by buyer inputs. BSV-21 extras must remain the
  // listed token and explicitly pay the buyer.
  for (let i = 3; i < args.tx.outputs.length; i++) {
    const output = args.tx.outputs[i]
    const script = output?.lockingScript?.toHex().toLowerCase() ?? ''
    const sats = output?.satoshis
    const bsvChange = isBuyerFundedBsvChangeOutput(script, sats)
    const tokenChange =
      args.listing.assetType === 'bsv21' &&
      sats === 1 &&
      isBuyerBsv21ValueLock(script, buyerChangeLock, args.listing.origin)
    if (!output || (!bsvChange && !tokenChange)) {
      throw new Error('Settlement contains a non-buyer change output')
    }
  }
  const seenInputs = new Set<string>()
  let inputSatoshis = 0
  for (const input of args.tx.inputs) {
    const point = `${String(input.sourceTXID).toLowerCase()}.${input.sourceOutputIndex}`
    if (seenInputs.has(point)) throw new Error('Duplicate settlement input')
    seenInputs.add(point)
    const source =
      input.sourceTransaction ?? args.beef.findTxid(String(input.sourceTXID))?.tx
    const sats = source?.outputs[input.sourceOutputIndex]?.satoshis
    if (!Number.isSafeInteger(sats) || sats == null || sats < 1) {
      throw new Error(`Settlement input source is missing: ${point}`)
    }
    inputSatoshis += sats
  }
  const outputSatoshis = args.tx.outputs.reduce(
    (sum, output) => sum + (output.satoshis ?? 0),
    0
  )
  if (inputSatoshis < outputSatoshis) {
    throw new Error('Settlement outputs exceed all validated inputs')
  }
}

/** True when the advert carries list-time seller unlocks a buyer can spend. */
export function listingHasBuyerCompletableSettlement(
  listing: Pick<MarketListingAdvert, 'settlementUnlocks'>,
  amounts?: { sellerSats: number; feeSats: number },
): boolean {
  const unlocks = listing.settlementUnlocks
  if (
    !unlocks ||
    unlocks.version !== 1 ||
    typeof unlocks.itemUnlockingScript !== 'string' ||
    typeof unlocks.offerUnlockingScript !== 'string' ||
    !unlocks.itemUnlockingScript.trim() ||
    !unlocks.offerUnlockingScript.trim()
  ) {
    return false
  }
  if (amounts) {
    if (unlocks.feeSats !== amounts.feeSats) return false
    const deposit = MARKET_OFFER_DEPOSIT_SATS
    if (
      unlocks.sellerSats !== amounts.sellerSats &&
      unlocks.sellerSats !== amounts.sellerSats - deposit
    ) {
      return false
    }
  }
  return true
}

export async function executeMarketPurchase(
  args: PurchaseMarketListingArgs & { intent: MarketPurchaseIntent }
): Promise<{
  saleId: string
  status: string
  txid?: string
  intent: MarketPurchaseIntent
  receipt?: MarketSettlementReceipt
  beef?: number[]
}> {
  return runExclusiveSpend(async () => {
    const t0 = Date.now()
    const mark = (phase: string) => {
      console.info(`[market-buy] +${Date.now() - t0}ms ${phase}`)
    }
    const active = getActiveWallet()
    if (!active) throw new Error('Wallet locked')
    if (active.chain !== 'main') throw new Error('Market settlement is mainnet only')
    const saleId = args.intent.intentId
    const listing = await hydrateMarketListingForPurchase(args.listing)
    mark(
      `listing unlocks=${String(listingHasBuyerCompletableSettlement(listing))} beef=${Boolean(overlayListingBeefBinary(listing, listingItemTxid(listing)))}`,
    )
    const provenance =
      listing.assetType === 'bsv21'
        ? undefined
        : parseProvenanceV2(args.provenance)
    if (listing.assetType !== 'bsv21' && !provenance) {
      throw new Error('Missing BRC-150 provenance')
    }
    if (
      args.intent.buyer.toLowerCase() !== active.identityKey.toLowerCase() ||
      !verifyMarketPurchaseIntent(args.intent, listing)
    ) {
      throw new MarketListingError(
        'INVALID_PURCHASE_INTENT',
        'Buyer-signed purchase intent does not match this listing.'
      )
    }
    const amounts = calculateMarketSettlement(listing.priceSats)
    const feeAddress = marketFeePayToAddress(listing)
    const feeLockingScript = new P2PKH().lock(feeAddress).toHex()
    const isBsv21 = listing.assetType === 'bsv21'
    if (isBsv21 && (listing.amt == null || !(listing.amt > 0))) {
      throw new MarketListingError(
        'MARKET_ASSET_UNSUPPORTED',
        'BSV-21 settlement requires a 162 amount.',
      )
    }
    const {
      abortReservedActionBatches,
      releaseStuckNosends,
    } = await import('./actionReview')
    await releaseStuckNosends(active)
    await abortReservedActionBatches(active, { budgetMs: 1_500 })
    mark('reservations released')
    // Buyer funds seller + fee outputs from local spendable BSV. Do not run
    // explorer/status recovery here: createAction is authoritative and returns a
    // deterministic insufficient-funds error without blocking the seller round trip.
    const fundingSats = amounts.sellerSats + amounts.feeSats + 100
    const listingMeta = listing as MarketListingAdvert & {
      name?: string | null
      sym?: string | null
      app?: string | null
      collectionId?: string | null
      content?: string | null
    }
    const itemDisplayName =
      listingMeta.sym?.trim() ||
      listingMeta.name?.trim() ||
      'Market item'
    const buyerLock = isBsv21
      ? buildBsv21ValueLock({
          tokenId: listing.origin,
          amount: BigInt(listing.amt!),
          address: active.address,
        })
      : new P2PKH().lock(active.address).toHex()
    const sellerLock = new P2PKH().lock(listing.payTo).toHex()
    const [itemTxid] = normalizeOutpoint(listing.outpoint).split('.')
    const [offerTxid] = normalizeOutpoint(listing.offerOutpoint).split('.')
    if (itemTxid !== offerTxid) {
      throw new Error('Market item and offer token must come from the same listing transaction')
    }
    const overlayBeef = overlayListingBeefBinary(listing, itemTxid!)
    if (overlayBeef) rememberBeefBinary(itemTxid!, overlayBeef)
    const inputBeef = overlayBeef
      ?? (await getBeefForTxidCached(active, itemTxid!, {
        needProof: true,
        allowUnprovenRawTx: true,
      })).toBinary()
    let created: Awaited<ReturnType<typeof active.wallet.createAction>>
    try {
      created = await active.wallet.createAction({
      description: 'Buy market collectable',
      labels: [
        'market-v3',
        'brc48',
        'brc153',
        `brc153-correlator:${saleId}`,
        `brc153-reference:${listing.offerOutpoint}`,
        '1sat',
      ],
      inputBEEF: inputBeef,
      inputs: [
        {
          outpoint: normalizeOutpoint(listing.outpoint),
          inputDescription: 'Listed market item',
          unlockingScriptLength: 108,
        },
        {
          outpoint: normalizeOutpoint(listing.offerOutpoint),
          inputDescription: 'BRC-48 offer token',
          unlockingScriptLength: 108,
        },
      ],
      outputs: [
        {
          lockingScript: buyerLock,
          satoshis: 1,
          outputDescription: 'Market item to buyer',
          ...buildMarketHeldRemittance({
            assetType: listing.assetType === 'bsv21' ? 'bsv21' : 'ordinal',
            origin: listing.origin,
            amt: listing.amt,
            name: itemDisplayName,
            ...(provenance ? { provenance } : {}),
          }),
        },
        {
          lockingScript: sellerLock,
          satoshis: amounts.sellerSats,
          outputDescription: 'Market seller proceeds',
        },
        {
          lockingScript: feeLockingScript,
          satoshis: amounts.feeSats,
          outputDescription: 'Market operator fee',
        },
      ],
      options: {
        randomizeOutputs: false,
        signAndProcess: false,
        noSend: true,
        trustSelf: 'known',
      },
    })
    } catch (err) {
      if (isInsufficientFundsError(err)) {
        throw new MarketListingError(
          'INSUFFICIENT_FUNDS',
          await describeInsufficientFunds(active.wallet, fundingSats),
        )
      }
      throw err
    }
    const signable = created.signableTransaction
    if (!signable)
      throw new Error('Market purchase did not return a signable transaction')
    const beef = Beef.fromBinary(signable.tx)
    const { vin: itemVin } = subjectTransaction(beef, listing.outpoint)
    const { vin: offerVin } = subjectTransaction(beef, listing.offerOutpoint)
    if (itemVin !== 0 || offerVin !== 1) {
      await active.wallet.abortAction({ reference: signable.reference }).catch(() => {})
      throw new Error('Wallet did not preserve item input0 and offer input1')
    }
    const settlementTx = subjectTransaction(beef, listing.outpoint).tx
    validateMarketSettlementOutputs({
      tx: settlementTx,
      beef,
      listing,
      buyerIdentityKey: active.identityKey,
      buyerAddress: active.address,
      chain: active.chain,
      itemVin,
      offerVin,
      itemOutputIndex: 0,
      sellerOutputIndex: 1,
      feeOutputIndex: 2,
    })
    // Prefer explicit args, else the advert's BRC-33 endpoint, else the wallet's
    // public messagebox. Omitting this forced default cloud routing and left the
    // buyer waiting out MARKET_SELLER_TIMEOUT when the seller never saw the wire.
    const sellerMessagebox =
      args.sellerMessagebox?.trim() ||
      (typeof listing.messagebox === 'string' ? listing.messagebox.trim() : '') ||
      undefined
    const buyerMessagebox =
      args.buyerMessagebox?.trim() || publicMessageboxBase() || undefined
    let pending: PendingPurchase = {
      saleId,
      reference: signable.reference,
      itemVin,
      offerVin,
      phase: 'preSignAbortable',
      expiresAt: Date.now() + SETTLEMENT_TIMEOUT_MS,
      sellerIdentityKey: listing.seller,
      intent: args.intent,
      ...(sellerMessagebox ? { sellerMessagebox } : {}),
    }
    const remember = (patch: Partial<PendingPurchase>): void => {
      pending = mergePendingPurchase(pending, patch)
      savePending(pending)
    }
    savePending(pending)
    const chart = createActor(marketPurchaseMachine).start()
    chart.send({
      type: 'START',
      listingKey: `${listing.outpoint}:${listing.nonce}`,
      path: {
        path: 'atomicPeerSettlement',
        sellerIdentityKey: listing.seller,
        feeIdentityKey: listing.feeIdentityKey,
      },
    })
    chart.send({ type: 'VERIFIED' })
    chart.send({ type: 'RESERVED', reference: signable.reference })
    try {
      const preSigned = listingHasBuyerCompletableSettlement(listing, amounts)
      const receiptPath = chooseMarketReceiptDeliveryPath({
        buyerIdentityKey: active.identityKey,
        sellerIdentityKey: listing.seller,
      })
      let itemUnlockingScript: string
      let offerUnlockingScript: string
      if (preSigned && listing.settlementUnlocks) {
        if (receiptPath.path === 'localSellerReconcile') {
          // List-time unlocks normally let a remote buyer skip the seller. For
          // a self-buy, reserve our local authorization too so the synchronous
          // receipt path can internalize proceeds and retire the listed inputs.
          reserveMarketListingAuthorization({
            outpoint: listing.outpoint,
            nonce: listing.nonce,
            saleId,
            buyerIdentityKey: active.identityKey,
            expiresAt: Math.min(
              pending.expiresAt,
              args.intent.expiresAt ?? pending.expiresAt,
            ),
            txCommitment: marketSettlementCommitment(settlementTx),
            intent: args.intent,
          })
        }
        itemUnlockingScript = listing.settlementUnlocks.itemUnlockingScript
        offerUnlockingScript = listing.settlementUnlocks.offerUnlockingScript
        chart.send({ type: 'SELLER_SIGNED' })
      } else if (receiptPath.path === 'localSellerReconcile') {
        // Same wallet is buyer and seller — sign locally; never wait on messagebox.
        const selfWire = {
          type: 'sign-request' as const,
          saleId,
          buyerIdentityKey: active.identityKey,
          buyerAddress: active.address,
          intent: args.intent,
          ...(buyerMessagebox ? { buyerMessagebox } : {}),
          listing,
          provenance,
          signableBeefB64: b64(signable.tx),
          itemVin,
          offerVin,
          itemOutputIndex: 0,
          sellerOutputIndex: 1,
          feeOutputIndex: 2,
          expiresAt: pending.expiresAt,
        }
        const signedLocal = await signSellerInputs({
          wire: selfWire,
          senderIdentityKey: active.identityKey,
        })
        itemUnlockingScript = signedLocal.itemUnlockingScript
        offerUnlockingScript = signedLocal.offerUnlockingScript
        chart.send({ type: 'SELLER_SIGNED' })
      } else {
        throw new MarketListingError(
          'MARKET_SELLER_TIMEOUT',
          'This listing has no list-time seller signature. Nothing was charged.',
        )
      }
      chart.send({ type: 'SIGNING' })
      remember({ phase: 'signedUnknown' })
      mark(preSigned ? 'signing with list-time unlocks' : 'signing')
      const signed = await active.wallet.signAction({
        reference: signable.reference,
        spends: {
          [itemVin]: { unlockingScript: itemUnlockingScript },
          [offerVin]: { unlockingScript: offerUnlockingScript },
        },
        options: { acceptDelayedBroadcast: true },
      })
      const txid = signed.txid
      const atomic = signed.tx ? Array.from(signed.tx) : undefined
      if (!txid || !atomic?.length)
        throw new Error('Signed market transaction missing')
      remember({ phase: 'signedUnknown', txid, atomicBeef: atomic })
      mark(`signed ${txid.slice(0, 12)} — Arcade postBeef once`)
      const broadcasted = await submitMarketSettlement(txid, atomic)
      if (!broadcasted) throw new Error('Market transaction broadcast failed')
      chart.send({ type: 'BROADCASTED' })
      remember({
        phase: 'broadcast',
        txid,
        atomicBeef: atomic,
      })
      // The offer coin is spent, but the overlay only learns that from a BRC-22
      // submission — without this the listing kept showing as active in market.
      clearSoldListingFromMarket({
        settlementBeef: atomic,
        buyerIdentityKey: active.identityKey,
        buyerAddress: active.address,
        listingOutpoints: [listing.outpoint, listing.offerOutpoint],
      })
      if (!isBsv21) {
        try {
          const purchasedOutpoint = `${txid}.0`
          const proven = provenance
            ? await provePurchasedMarketTip({
                active,
                provenance,
                outpoint: purchasedOutpoint,
                atomic,
              })
            : false
          const {
            noteIngestedItem,
            retireCollectableAfterSpend,
          } = await import('./collectables')
          // On a self-purchase, origin deduplication would otherwise retain the
          // sold tip and hide txid.0. Retire the exact spent tip before painting
          // the buyer output that Activity already reports.
          if (receiptPath.path === 'localSellerReconcile') {
            retireCollectableAfterSpend(listing.outpoint, txid)
          }
          noteIngestedItem({
            outpoint: purchasedOutpoint,
            chain: active.chain,
            origin: listing.origin,
            name: itemDisplayName,
            app: listingMeta.app,
            collectionId: listingMeta.collectionId,
            content: listingMeta.content,
            identityKey: active.identityKey,
          })
          mark(`buyer collectable painted proven=${String(proven)}`)
        } catch (err) {
          // Local cache projection is recoverable from listOutputs; custody and
          // the durable Activity row must not be rolled back for a paint error.
          console.warn(
            '[market-buy] buyer collectable paint deferred',
            err instanceof Error ? err.message : String(err),
          )
        }
      }
      const receiptWire = {
        recipientIdentityKey: listing.seller,
        rootKeyHex: active.rootKeyHex,
        senderIdentityKey: active.identityKey,
        messagebox: sellerMessagebox,
        wire: {
          type: 'receipt' as const,
          saleId,
          txid,
          atomicBeefB64: b64(atomic),
          ...(buyerMessagebox ? { buyerMessagebox } : {}),
        },
      }
      // The settlement tx is already committed. A self-purchase must release
      // the spend lease before it creates the seller-proceeds sweep; awaiting
      // that second transaction here made the Buy request take nearly a minute.
      const handoff = await sellerHandoffOutcome(receiptPath, receiptWire)
      mark(
        handoff.handoff === 'boxAccepted'
          ? 'seller remittance in messagebox'
          : handoff.handoff === 'localSweepDeferred'
            ? 'local seller sweep deferred past spend lease'
            : `seller messagebox unreachable (${handoff.reason})`,
      )
      chart.send({ type: 'COMMITTED' })
      remember({
        phase: 'committed',
        txid,
        atomicBeef: atomic,
      })
      // Once the box holds the receipt, store-and-forward owns delivery and this
      // record has no further duty — an offline seller is not a pending purchase.
      if (handoff.handoff === 'boxAccepted') removePending(saleId)
      else {
        // Either nothing was ever stored (box unreachable) or there is no box in
        // this sale at all (local seller). Both need a local pass we cannot run
        // inside the spend lease that is still held by this createAction.
        setTimeout(() => {
          void recoverPendingMarketPurchases().catch((err) => {
            console.warn(
              '[market-buy] seller reconciliation failed',
              err instanceof Error ? err.message : String(err),
            )
          })
        }, 0)
      }
      recordAppActivity({
        origin: WALLET_ACTIVITY_ORIGIN,
        kind: 'spent',
        sats: listing.priceSats,
        method: 'market-purchase',
        note: 'Bought market collectable',
        txid,
      })
      recordAppActivity({
        origin: WALLET_ACTIVITY_ORIGIN,
        kind: 'earned',
        sats: 1,
        method: 'market-purchase-receive',
        note: 'Received market collectable',
        txid,
        item: {
          name: itemDisplayName,
          origin: listing.origin,
          outpoint: `${txid}.0`,
        },
        status: 'complete',
      })
      scheduleHistoryBackupPush('market-purchase')
      mark('done status=broadcast')
      return {
        saleId,
        status: 'broadcast',
        txid,
        intent: args.intent,
        beef: atomic,
      }
    } catch (err) {
      const snapshot = chart.getSnapshot()
      const reason = err instanceof Error ? err.message : String(err)
      const code =
        err && typeof err === 'object' && 'code' in err
          ? String((err as { code?: unknown }).code ?? '')
          : ''
      const arcadeHardReject =
        code === 'ARCADE_HARD_REJECT' ||
        /ARCADE_HARD_REJECT/i.test(reason) ||
        (pending.txid != null &&
          (await import('./ghostTxSuppress')).isGhostTxSuppressed(pending.txid))
      // Abort whenever Arcade never accepted — including after sign, when we
      // already have a local txid/atomicBEEF that miners hard-rejected.
      const mayAbort =
        mayAbortMarketPurchase(snapshot) &&
        (!pending.txid ||
          !pending.atomicBeef?.length ||
          arcadeHardReject)
      if (mayAbort) {
        await active.wallet
          .abortAction({ reference: signable.reference })
          .catch(() => {})
        removePending(saleId)
        chart.send({ type: 'ABORTED' })
      } else {
        remember({ phase: 'recovery' })
        chart.send({ type: 'RECOVER' })
      }
      chart.send({
        type: 'FAIL',
        error: reason,
      })
      throw err
    } finally {
      chart.stop()
    }
  }, undefined, { promote: false })
}

export async function recoverPendingMarketPurchases(): Promise<void> {
  const active = getActiveWallet()
  if (!active) return
  const { isGhostTxSuppressed } = await import('./ghostTxSuppress')
  for (const record of readJson<PendingPurchase[]>(PENDING_KEY, [])) {
    const receiptPath = choosePendingMarketReceiptPath({
      activeIdentityKey: active.identityKey,
      buyerIdentityKey: record.intent.buyer,
      sellerIdentityKey: record.sellerIdentityKey,
    })
    if (receiptPath.path === 'skip') continue
    if (record.txid && isGhostTxSuppressed(record.txid)) {
      await active.wallet.abortAction({ reference: record.reference }).catch(() => {})
      removePending(record.saleId)
      console.info(
        '[market] pending purchase aborted — Arcade ghost',
        record.saleId,
        record.txid.slice(0, 12),
      )
      continue
    }
    if (!record.txid && Date.now() >= record.expiresAt) {
      const listed = await active.wallet
        .listActions({
          labels: [`brc153-correlator:${record.saleId}`],
          labelQueryMode: 'all',
          includeLabels: true,
          limit: 10,
          seekPermission: false,
        })
        .catch(() => ({ actions: [] as Array<{ txid?: string; status?: string }> }))
      const signed = listed.actions?.find(
        (action) =>
          /^[0-9a-f]{64}$/i.test(action.txid ?? '') &&
          action.status !== 'failed' &&
          action.status !== 'unsigned',
      )
      if (!signed) {
        await active.wallet.abortAction({ reference: record.reference }).catch(() => {})
        removePending(record.saleId)
      }
      continue
    }
    if (!record.txid || !record.atomicBeef?.length) continue
    // A broadcast/committed record has already entered the miner outbox. Its
    // remaining duty is seller reconciliation, not another blocking postBeef.
    if (record.phase === 'signedUnknown' || record.phase === 'recovery') {
      try {
        await submitMarketSettlement(record.txid, record.atomicBeef)
      } catch (err) {
        console.warn(
          '[market] pending purchase rebroadcast skipped',
          record.saleId,
          err instanceof Error ? err.message : String(err),
        )
        if (isGhostTxSuppressed(record.txid)) {
          await active.wallet.abortAction({ reference: record.reference }).catch(() => {})
          removePending(record.saleId)
        }
        continue
      }
    }
    const receiptWire = {
      type: 'receipt' as const,
      saleId: record.saleId,
      txid: record.txid,
      atomicBeefB64: b64(record.atomicBeef),
    }
    const handedOff = receiptPath.path === 'localSellerReconcile'
      ? await handleInboundMarketSettlementWire({
          wire: receiptWire,
          senderIdentityKey: active.identityKey,
          messagebox: record.sellerMessagebox,
          localSelfPurchase: true,
        })
      : await deliverMarketSettlementWire({
          recipientIdentityKey: receiptPath.sellerIdentityKey,
          rootKeyHex: active.rootKeyHex,
          senderIdentityKey: active.identityKey,
          messagebox: record.sellerMessagebox,
          wire: receiptWire,
        })
    if (handedOff) {
      removePending(record.saleId)
      console.info(
        `[market] seller ${receiptPath.path === 'localSellerReconcile' ? 'proceeds reconciled' : 'receipt delivered'}`,
        record.saleId,
      )
    }
  }
}

export async function recoverMarketSettlementReceipt(args: {
  intent: MarketPurchaseIntent
}): Promise<MarketSettlementReceipt | null> {
  const active = getActiveWallet()
  if (!active) throw new Error('Wallet locked')
  await recoverPendingMarketPurchases()
  const pending = readJson<PendingPurchase[]>(PENDING_KEY, []).find(
    (item) =>
      item.saleId === args.intent.intentId &&
      item.sellerIdentityKey.toLowerCase() === args.intent.seller.toLowerCase()
  )
  if (!pending) return null
  let txid = pending.txid
  let atomic = pending.atomicBeef
  if (!txid) {
    const listed = await active.wallet.listActions({
      labels: [`brc153-correlator:${args.intent.intentId}`],
      labelQueryMode: 'all',
      includeLabels: true,
      limit: 10,
      seekPermission: false,
    })
    const recovered = listed.actions.find(
      (action) =>
        /^[0-9a-f]{64}$/i.test(action.txid) &&
        action.status !== 'failed' &&
        action.status !== 'unsigned'
    )
    txid = recovered?.txid?.toLowerCase()
  }
  if (txid && !atomic?.length) {
    try {
      const { getAtomicBeefBinaryForTxid } = await import('./beefCache')
      atomic = await getAtomicBeefBinaryForTxid(active, txid)
    } catch {
      atomic = undefined
    }
  }
  if (txid && atomic?.length) {
    savePending(mergePendingPurchase(pending, { phase: 'recovery', txid, atomicBeef: atomic }))
    await deliverMarketSettlementWire({
      recipientIdentityKey: pending.sellerIdentityKey,
      rootKeyHex: active.rootKeyHex,
      senderIdentityKey: active.identityKey,
      messagebox: pending.sellerMessagebox,
      wire: {
        type: 'receipt',
        saleId: pending.saleId,
        txid,
        atomicBeefB64: b64(atomic),
      },
    })
  }
  await pollInboundTipHints({ rootKeyHex: active.rootKeyHex })
  const response = takeResponse(
    args.intent.intentId,
    'receipt-response'
  ) as Extract<StoredResponse, { type: 'receipt-response' }> | null
  const receipt = response?.receipt
  if (
    !receipt ||
    !verifyMarketSettlementReceipt(receipt, args.intent) ||
    receipt.settlementTxid.toLowerCase() !== response.txid.toLowerCase() ||
    (txid != null && receipt.settlementTxid.toLowerCase() !== txid)
  ) {
    return null
  }
  removePending(args.intent.intentId)
  return receipt
}

async function signSellerInputs(args: {
  wire: Extract<MarketSettlementWire, { type: 'sign-request' }>
  senderIdentityKey: string
}): Promise<{ itemUnlockingScript: string; offerUnlockingScript: string }> {
  const active = getActiveWallet()
  if (!active) throw new Error('Wallet locked')
  if (
    args.senderIdentityKey.toLowerCase() !==
    args.wire.buyerIdentityKey.toLowerCase()
  ) {
    throw new Error('Buyer identity does not match authenticated BRC-33 sender')
  }
  if (Date.now() >= args.wire.expiresAt)
    throw new Error('Settlement request expired')
  const listing = args.wire.listing as MarketListingAdvert
  const intent = args.wire.intent as MarketPurchaseIntent
  if (
    !intent ||
    intent.intentId !== args.wire.saleId ||
    intent.buyer.toLowerCase() !== args.wire.buyerIdentityKey.toLowerCase() ||
    !verifyMarketPurchaseIntent(intent, listing)
  ) {
    throw new Error('Buyer purchase intent is invalid or mismatches the listing')
  }
  const proof = await verifyMarketListingProvenance({
    listing,
    provenance: args.wire.provenance,
  })
  if (!proof.verified) throw new Error(proof.reason || 'Invalid listing proof')
  const local = getMarketListingAuthorization({
    outpoint: listing.outpoint,
    nonce: listing.nonce,
  })
  if (
    !local ||
    local.state !== 'active' ||
    local.seller !== active.identityKey.toLowerCase() ||
    local.priceSats !== listing.priceSats ||
    local.provenanceHash !== listing.provenanceHash
  ) {
    throw new Error('Listing is not locally authorized and active')
  }
  const bytes = decodeBeefB64(args.wire.signableBeefB64)
  if (!bytes) throw new Error('Invalid signable AtomicBEEF')
  const beef = Beef.fromBinary(bytes)
  const { tx, vin } = subjectTransaction(beef, listing.outpoint)
  if (vin !== args.wire.itemVin) throw new Error('Listed item vin mismatch')
  const offerSubject = subjectTransaction(beef, listing.offerOutpoint)
  if (
    offerSubject.tx !== tx ||
    offerSubject.vin !== args.wire.offerVin ||
    vin !== 0 ||
    offerSubject.vin !== 1
  ) {
    throw new Error('Listed item and offer inputs are not exact seller inputs 0/1')
  }
  const source =
    tx.inputs[vin]?.sourceTransaction ??
    beef.findTxid(String(tx.inputs[vin]?.sourceTXID))?.tx
  const sourceOutput = source?.outputs[tx.inputs[vin]!.sourceOutputIndex]
  if (!sourceOutput || sourceOutput.satoshis !== 1) {
    throw new Error('Listed source output is not one satoshi')
  }
  validateMarketSettlementOutputs({
    tx,
    beef,
    listing,
    buyerIdentityKey: args.wire.buyerIdentityKey,
    buyerAddress: args.wire.buyerAddress ?? addressFromIdentityKey(args.wire.buyerIdentityKey, active.chain),
    chain: active.chain,
    itemVin: vin,
    offerVin: offerSubject.vin,
    itemOutputIndex: args.wire.itemOutputIndex,
    sellerOutputIndex: args.wire.sellerOutputIndex,
    feeOutputIndex: args.wire.feeOutputIndex,
  })
  reserveMarketListingAuthorization({
    outpoint: listing.outpoint,
    nonce: listing.nonce,
    saleId: args.wire.saleId,
    buyerIdentityKey: args.wire.buyerIdentityKey,
    expiresAt: Math.min(args.wire.expiresAt, intent.expiresAt ?? 0),
    txCommitment: marketSettlementCommitment(tx),
    intent,
  })
  tx.inputs[vin]!.sourceTransaction = source
  tx.inputs[vin]!.unlockingScriptTemplate = SetupClient.getUnlockP2PKH(
    PrivateKey.fromHex(active.rootKeyHex),
    1
  )
  const offerInput = tx.inputs[offerSubject.vin]!
  offerInput.sourceTransaction =
    offerInput.sourceTransaction ??
    beef.findTxid(String(offerInput.sourceTXID))?.tx
  offerInput.unlockingScriptTemplate = SetupClient.getUnlockP2PKH(
    PrivateKey.fromHex(active.rootKeyHex),
    MARKET_OFFER_DEPOSIT_SATS
  )
  await tx.sign()
  const itemUnlockingScript = tx.inputs[vin]!.unlockingScript?.toHex()
  const offerUnlockingScript = tx.inputs[offerSubject.vin]!.unlockingScript?.toHex()
  if (!itemUnlockingScript || !offerUnlockingScript) {
    throw new Error('Seller item/offer signatures missing')
  }
  return { itemUnlockingScript, offerUnlockingScript }
}

/** Per-settlement backoff for compact receipts whose tx is not visible yet. */
const receiptBeefRetryAt = new Map<string, number>()
const RECEIPT_BEEF_RETRY_MS = 5 * 60_000

/**
 * First time each settlement's BEEF could not be found, kept across restarts so
 * the wait is bounded by wall-clock rather than by session length.
 */
const receiptBeefMisses = createDurableTtlTxidMap({
  key: 'handcash.market.receiptBeefMiss.v1',
  max: 200,
  ttlMs: 24 * 60 * 60_000,
})

/**
 * How long a compact receipt may wait for a transaction no provider has.
 *
 * "Not visible yet" is normally minutes of indexer lag. It is also what a buyer's
 * settlement looks like when its ancestry was rejected and can never confirm —
 * and that receipt was retried on every inbox poll forever (lab hc-ad7afb: two
 * sales retrying every ~20s for hours). Past this the message is consumed.
 */
const RECEIPT_BEEF_GIVE_UP_MS = 60 * 60_000

export async function handleInboundMarketSettlementWire(args: {
  wire: MarketSettlementWire
  senderIdentityKey: string
  messagebox?: string
  /** Buyer and seller are this wallet; skip a redundant receipt-response hop. */
  localSelfPurchase?: boolean
}): Promise<boolean> {
  const active = getActiveWallet()
  if (!active) return false
  if (
    args.wire.type === 'sign-response' ||
    args.wire.type === 'receipt-response'
  ) {
    if (
      args.senderIdentityKey.toLowerCase() !==
      readJson<PendingPurchase[]>(PENDING_KEY, [])
        .find((item) => item.saleId === args.wire.saleId)
        ?.sellerIdentityKey.toLowerCase()
    ) {
      return false
    }
    saveResponse(args.wire)
    return true
  }
  if (args.wire.type === 'receipt') {
    const saleId = args.wire.saleId
    const settlementTxid = args.wire.txid
    const refuse = (reason: string): false => {
      console.warn(
        `[market-sale] receipt refused — ${reason}`,
        `sale=${saleId.slice(0, 12)}`,
        `tx=${settlementTxid.slice(0, 12)}`,
      )
      return false
    }
    /**
     * Consume the message. Reserved for verdicts that cannot change: waiting
     * only re-runs BEEF hydration and payout checks on every poll and nav.
     */
    const discard = (reason: string): true => {
      console.warn(
        `[market-sale] receipt discarded — ${reason}`,
        `sale=${saleId.slice(0, 12)}`,
        `tx=${settlementTxid.slice(0, 12)}`,
      )
      return true
    }
    const settle = (reason: MarketReceiptRefusal): boolean =>
      marketReceiptRefusalIsTerminal(reason) ? discard(reason) : refuse(reason)
    let atomic = decodeBeefB64(args.wire.atomicBeefB64)
    if (!atomic) {
      const firstMissAt = receiptBeefMisses.rememberedAt(settlementTxid)
      if (
        firstMissAt != null &&
        Date.now() - firstMissAt >= RECEIPT_BEEF_GIVE_UP_MS
      ) {
        receiptBeefMisses.forget(settlementTxid)
        receiptBeefRetryAt.delete(settlementTxid)
        return discard(
          'settlement beef never became available — no provider has the buyer’s transaction',
        )
      }
      const retryAt = receiptBeefRetryAt.get(settlementTxid) ?? 0
      // Waiting out the backoff is the expected state, so it is silent. Logging
      // it turned one unfindable settlement into a line every inbox poll.
      if (Date.now() < retryAt) return false
      try {
        const fetched = await getBeefForTxidCached(active, args.wire.txid, {
          needProof: false,
          allowUnprovenRawTx: true,
        })
        atomic = Array.from(fetched.toBinaryAtomic(args.wire.txid))
        receiptBeefRetryAt.delete(settlementTxid)
        receiptBeefMisses.forget(settlementTxid)
        console.info(
          '[market-sale] hydrated compact receipt BEEF',
          args.wire.txid.slice(0, 12),
        )
      } catch {
        // Leave the BRC-33 message unacknowledged. The next lightweight inbox
        // poll retries once miners/indexers expose the buyer's transaction —
        // but not on every poll and navigation, which is a multi-provider
        // lookup per attempt for a transaction nobody can see yet.
        receiptBeefRetryAt.set(settlementTxid, Date.now() + RECEIPT_BEEF_RETRY_MS)
        if (firstMissAt == null) receiptBeefMisses.remember(settlementTxid)
        return refuse('settlement beef not available yet — will retry')
      }
    }
    let finalTx: Transaction
    try {
      const found = Beef.fromBinary(atomic).findTxid(args.wire.txid)?.tx
      if (!found) throw new Error('settlement tx missing from receipt beef')
      finalTx = found
    } catch (err) {
      return refuse(err instanceof Error ? err.message : String(err))
    }
    if (finalTx.id('hex').toLowerCase() !== args.wire.txid.toLowerCase()) {
      return discard('settlement txid does not match the receipt')
    }
    const spentOutpoints = finalTx.inputs.map(
      (input) => `${String(input.sourceTXID).toLowerCase()}.${input.sourceOutputIndex}`,
    )
    const spent = new Set(spentOutpoints)
    const settlesLocalListing = (record: MarketListingAuthorization): boolean => {
      const token = record.listing
      if (!token) return false
      return (
        spent.has(normalizeOutpoint(token.outpoint)) &&
        spent.has(normalizeOutpoint(token.offerOutpoint))
      )
    }
    const authority = chooseMarketReceiptAuthority({
      senderIdentityKey: args.senderIdentityKey,
      activeIdentityKey: active.identityKey,
      settlementTxid: args.wire.txid,
      reserved: findMarketListingAuthorizationBySaleId(args.wire.saleId),
      settledLocally:
        listMarketListingAuthorizations().find(settlesLocalListing) ?? null,
    })
    if (authority.path === 'refuse') return settle(authority.reason)
    const authorization = authority.authorization
    const listing = authorization.listing
    if (!listing) return settle('listing-has-no-token')
    let receipt: MarketSettlementReceipt | null = null
    if (authority.path === 'reservedBySignHop') {
      if (
        marketSettlementCommitment(finalTx) !==
        authorization.reservationTxCommitment
      ) {
        return discard('settlement shape differs from the reserved commitment')
      }
      const intent = authorization.reservationIntent
      if (!intent || !verifyMarketPurchaseIntent(intent, listing)) {
        return discard('reserved purchase intent does not verify')
      }
      receipt = createMarketSettlementReceipt({
        intent,
        settlementTxid: args.wire.txid,
        sellerOutputIndex: 1,
        feeOutputIndex: 2,
      })
    } else {
      // Pre-signed listing: the buyer never asked us to sign, so the transaction
      // is the only authority. It must spend our item and offer and pay our own
      // payTo plus the market fee.
      const payout = verifyMarketSettlementPayout({
        listing,
        spentOutpoints,
        outputs: finalTx.outputs.map((output) => ({
          satoshis: output.satoshis,
          lockingScriptHex: output.lockingScript?.toHex(),
        })),
      })
      if (!payout.ok) return settle(payout.reason)
      adoptMarketSaleReceipt({
        outpoint: authorization.outpoint,
        nonce: authorization.nonce,
        saleId: args.wire.saleId,
        buyerIdentityKey: args.senderIdentityKey,
      })
      console.info(
        '[market-sale] list-time unlock sale adopted',
        `sale=${args.wire.saleId.slice(0, 12)}`,
        `seller=${payout.sellerSats} fee=${payout.feeSats}`,
      )
    }
    const receiptBroadcast = chooseMarketReceiptBroadcastPath({
      localSelfPurchase: args.localSelfPurchase === true,
    })
    const accepted =
      receiptBroadcast.broadcast === 'alreadyConfirmedByLocalBuyer'
        ? true
        : await submitMarketSettlement(args.wire.txid, atomic)
    if (!accepted && authorization.settlementTxid !== args.wire.txid.toLowerCase()) {
      return refuse('settlement was not accepted by a miner')
    }
    let progress = markMarketSettlementProgress({
      saleId: args.wire.saleId,
      settlementTxid: args.wire.txid,
    })
    const buyerIdentityKey = args.senderIdentityKey
    const chart = createActor(marketSellerSettlementMachine).start()
    chart.send({
      type: 'START',
      listingKey: `${authorization.outpoint}:${authorization.nonce}`,
      buyerIdentityKey,
      path: {
        settle: 'peerDeliver',
        buyerIdentityKey,
        listingKey: `${authorization.outpoint}:${authorization.nonce}`,
      },
    })
    chart.send({ type: 'VALIDATED' })
    chart.send({ type: 'SELLER_INPUTS_SIGNED' })
    chart.send({ type: 'DELIVERED' })
    chart.send({ type: 'BROADCAST_CONFIRMED' })
    if (!progress.proceedsInternalized) {
      const swept = await sweepVisibleP2pkhOutpoints(
        active,
        [`${args.wire.txid}.1`],
        atomic,
      )
      if (!swept[0]?.success) {
        chart.send({
          type: 'FAIL',
          error: swept[0]?.error ?? 'Seller proceeds ingest failed',
        })
        chart.stop()
        return false
      }
      progress = markMarketSettlementProgress({
        saleId: args.wire.saleId,
        settlementTxid: args.wire.txid,
        proceedsInternalized: true,
      })
      bumpBalanceAfterHeal()
    }
    chart.send({ type: 'PROCEEDS_INTERNALIZED' })
    if (!progress.itemRetired) {
      const retireErrors: string[] = []
      for (const spend of [
        {
          basket: listing.assetType === 'bsv21' ? 'bsv21' : '1sat',
          output: listing.outpoint.replace('_', '.'),
        },
        { basket: 'market-offers', output: listing.offerOutpoint.replace('_', '.') },
      ]) {
        try {
          await active.wallet.relinquishOutput(spend)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (!/not found|already|missing|must exist/i.test(msg)) {
            retireErrors.push(msg)
          }
        }
      }
      if (retireErrors.length) {
        chart.send({ type: 'FAIL', error: retireErrors[0]! })
        chart.stop()
        return refuse(`sold inputs could not be retired — ${retireErrors[0]!}`)
      }
      progress = markMarketSettlementProgress({
        saleId: args.wire.saleId,
        settlementTxid: args.wire.txid,
        itemRetired: true,
      })
    }
    const { retireCollectableAfterSpend } = await import('./collectables')
    retireCollectableAfterSpend(listing.outpoint, args.wire.txid)
    chart.send({ type: 'ITEM_RETIRED' })
    // Backstop for a buyer whose announce never landed (offline, refused host).
    // A self-purchase already announced on the buyer leg.
    if (!args.localSelfPurchase && atomic.length) {
      clearSoldListingFromMarket({
        settlementBeef: atomic,
        buyerIdentityKey: args.senderIdentityKey,
        listingOutpoints: [listing.outpoint, listing.offerOutpoint],
      })
    }
    if (progress.state !== 'settled') {
      updateMarketListingAuthorization({
        outpoint: authorization.outpoint,
        nonce: authorization.nonce,
        // A list-time-unlock sale is still `active` here — it was never reserved.
        from: ['active', 'reserved'],
        to: 'settled',
        reason: args.wire.txid,
      })
    }
    // Only a sign-hop sale has a buyer waiting on a countersigned receipt. A
    // buyer that settled with list-time unlocks already holds the item, so a
    // failed response hop must not undo an ingested sale.
    if (!args.localSelfPurchase && receipt) {
      const responseDelivered = await deliverMarketSettlementWire({
        wire: {
          type: 'receipt-response',
          saleId: args.wire.saleId,
          txid: args.wire.txid,
          broadcasted: true,
          receipt,
          ...(!accepted ? { reason: 'Seller broadcast failed' } : {}),
        },
        recipientIdentityKey: args.senderIdentityKey,
        rootKeyHex: active.rootKeyHex,
        senderIdentityKey: active.identityKey,
        messagebox: args.wire.buyerMessagebox,
      })
      if (!responseDelivered) {
        chart.stop()
        return refuse('receipt response could not be delivered to the buyer')
      }
    }
    chart.stop()
    scheduleHistoryBackupPush('market-sale')
    if (listing) {
      const proceeds = calculateMarketSettlement(listing.priceSats).sellerSats
      const soldItem = getResolvedInscription(listing.outpoint)
      recordAppActivity({
        origin: WALLET_ACTIVITY_ORIGIN,
        kind: 'spent',
        sats: 1,
        method: 'market-sale',
        note: 'Sold market collectable',
        txid: args.wire.txid,
        item: {
          name: soldItem?.name?.trim() || 'Market collectable',
          origin: listing.origin,
          outpoint: listing.outpoint,
          ...(soldItem?.app ? { app: soldItem.app } : {}),
        },
        status: 'complete',
      })
      recordAppActivity({
        origin: WALLET_ACTIVITY_ORIGIN,
        kind: 'earned',
        sats: proceeds,
        method: 'market-sale-proceeds',
        note: 'Market sale proceeds',
        txid: args.wire.txid,
      })
    }
    return true
  }
  const listing = args.wire.listing as MarketListingAdvert
  const chart = createActor(marketSellerSettlementMachine).start()
  chart.send({
    type: 'START',
    listingKey: `${listing.outpoint}:${listing.nonce}`,
    buyerIdentityKey: args.wire.buyerIdentityKey,
    path: {
      settle: 'peerDeliver',
      buyerIdentityKey: args.wire.buyerIdentityKey,
      listingKey: `${listing.outpoint}:${listing.nonce}`,
    },
  })
  let response: StoredResponse
  try {
    chart.send({ type: 'VALIDATED' })
    const signatures = await signSellerInputs({
      wire: args.wire,
      senderIdentityKey: args.senderIdentityKey,
    })
    chart.send({ type: 'SELLER_INPUTS_SIGNED' })
    response = {
      type: 'sign-response',
      saleId: args.wire.saleId,
      accepted: true,
      unlockingScript: signatures.itemUnlockingScript,
      offerUnlockingScript: signatures.offerUnlockingScript,
    }
  } catch (err) {
    chart.send({
      type: 'FAIL',
      error: err instanceof Error ? err.message : String(err),
    })
    response = {
      type: 'sign-response',
      saleId: args.wire.saleId,
      accepted: false,
      reason: err instanceof Error ? err.message : String(err),
    }
  }
  const delivered = await deliverMarketSettlementWire({
    wire: response,
    recipientIdentityKey: args.wire.buyerIdentityKey,
    rootKeyHex: active.rootKeyHex,
    senderIdentityKey: active.identityKey,
    messagebox: args.wire.buyerMessagebox,
  })
  if (delivered && response.accepted) chart.send({ type: 'DELIVERED' })
  chart.stop()
  return delivered
}
