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
import { getBeefForTxidCached } from './beefCache'
import {
  calculateMarketSettlement,
  createMarketSettlementReceipt,
  findMarketListingAuthorizationBySaleId,
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
  type MarketPurchaseIntent,
  type MarketSettlementReceipt,
  type PurchaseMarketListingArgs,
} from './marketListing'
import {
  buildCollectableCustomInstructions,
  parseProvenanceV2,
} from './oneSatProvenance'
import {
  ONESAT_FT_BASKET,
  buildColourCustomInstructions,
  colourTags,
} from './colourCoins'
import {
  MARKET_ITEM_VOUT,
  MARKET_OFFER_DEPOSIT_SATS,
  parseMarketOffer,
} from './marketOverlayProtocol'
import { getActiveWallet } from './session'
import { broadcastAtomicBeef } from './sendBrc29Payment'
import {
  decodeBeefB64,
  deliverMarketSettlementWire,
  pollInboundTipHints,
  type MarketSettlementWire,
} from './messageTransport'
import { durableGetItem, durableSetItem } from './durableStorage'
import { runExclusiveSpend } from './spendGuard'
import { scheduleHistoryBackupPush } from './deviceSync'
import { recordAppActivity, WALLET_ACTIVITY_ORIGIN } from './appActivity'
import { sweepVisibleP2pkhOutpoints } from './importP2pkhFunding'

const PENDING_KEY = 'handcash.market.pending.v2'
const RESPONSE_KEY = 'handcash.market.responses.v2'
const SETTLEMENT_TIMEOUT_MS = 90_000

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

export function validateMarketSettlementOutputs(args: {
  tx: Transaction
  beef: Beef
  listing: MarketListingAdvert
  buyerIdentityKey: string
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
  const buyerAddress = PublicKey.fromString(args.buyerIdentityKey).toAddress(
    args.chain === 'main' ? 'mainnet' : 'testnet'
  )
  const buyerLock = new P2PKH().lock(buyerAddress).toHex()
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
    !outputEquals(args.tx, args.itemOutputIndex, 1, buyerLock) ||
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
  for (let i = 3; i < args.tx.outputs.length; i++) {
    const output = args.tx.outputs[i]
    if (
      !output ||
      !(typeof output.satoshis === 'number' && output.satoshis > 0) ||
      output.lockingScript?.toHex().toLowerCase() !== buyerLock.toLowerCase()
    ) {
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

async function waitForSellerResponse<T extends StoredResponse['type']>(
  saleId: string,
  type: T,
  timeoutMs = SETTLEMENT_TIMEOUT_MS
): Promise<Extract<StoredResponse, { type: T }>> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = takeResponse(saleId, type)
    if (found) return found as Extract<StoredResponse, { type: T }>
    await pollInboundTipHints({
      rootKeyHex: getActiveWallet()?.rootKeyHex ?? '',
    })
    await new Promise((resolve) => setTimeout(resolve, 750))
  }
  throw new MarketListingError(
    'MARKET_SELLER_TIMEOUT',
    'Seller did not return an item signature before timeout.'
  )
}

export async function executeMarketPurchase(
  args: PurchaseMarketListingArgs
): Promise<{
  saleId: string
  status: string
  txid?: string
  intent: MarketPurchaseIntent
  receipt?: MarketSettlementReceipt
}> {
  return runExclusiveSpend(async () => {
    const active = getActiveWallet()
    if (!active) throw new Error('Wallet locked')
    if (active.chain !== 'main') throw new Error('Market settlement is mainnet only')
    const saleId = args.intent.intentId
    const listing = args.listing
    const proof = await verifyMarketListingProvenance({
      listing,
      provenance: args.provenance,
    })
    if (!proof.verified) {
      throw new MarketListingError(
        'ITEM_ORIGIN_UNPROVEN',
        proof.reason ?? 'Listing provenance is invalid.'
      )
    }
    const provenance = parseProvenanceV2(args.provenance)
    if (!provenance) throw new Error('Missing BRC-150 provenance')
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
    const buyerLock = new P2PKH().lock(active.address).toHex()
    const sellerLock = new P2PKH().lock(listing.payTo).toHex()
    const [itemTxid] = normalizeOutpoint(listing.outpoint).split('.')
    const [offerTxid] = normalizeOutpoint(listing.offerOutpoint).split('.')
    if (itemTxid !== offerTxid) {
      throw new Error('Market item and offer token must come from the same listing transaction')
    }
    const inputBeef = (await getBeefForTxidCached(active, itemTxid!, { needProof: true })).toBinary()
    const created = await active.wallet.createAction({
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
          basket: listing.assetType === '1sat-ft' ? ONESAT_FT_BASKET : '1sat',
          tags:
            listing.assetType === '1sat-ft'
              ? colourTags(listing.origin)
              : ['ordinal', `origin:${listing.origin.replace('_', '.')}`],
          customInstructions:
            listing.assetType === '1sat-ft'
              ? buildColourCustomInstructions({
                  origin: listing.origin,
                  amt: listing.amt,
                  provenance,
                })
              : buildCollectableCustomInstructions({
                  origin: listing.origin,
                  name: 'Market item',
                  provenance,
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
      chain: active.chain,
      itemVin,
      offerVin,
      itemOutputIndex: 0,
      sellerOutputIndex: 1,
      feeOutputIndex: 2,
    })
    const sellerMessagebox = args.sellerMessagebox
    const buyerMessagebox = args.buyerMessagebox
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
      const delivered = await deliverMarketSettlementWire({
        recipientIdentityKey: listing.seller,
        rootKeyHex: active.rootKeyHex,
        senderIdentityKey: active.identityKey,
        messagebox: sellerMessagebox,
        wire: {
          type: 'sign-request',
          saleId,
          buyerIdentityKey: active.identityKey,
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
        },
      })
      if (!delivered) throw new Error('Seller messagebox is unreachable')
      const response = await waitForSellerResponse(saleId, 'sign-response')
      if (!response.accepted || !response.unlockingScript) {
        throw new Error(response.reason || 'Seller refused settlement')
      }
      chart.send({ type: 'SELLER_SIGNED' })
      const offerUnlockingScript = response.offerUnlockingScript
      if (!offerUnlockingScript) throw new Error('Seller offer-token signature missing')
      chart.send({ type: 'SIGNING' })
      remember({ phase: 'signedUnknown' })
      const signed = await active.wallet.signAction({
        reference: signable.reference,
        spends: {
          [itemVin]: { unlockingScript: response.unlockingScript },
          [offerVin]: { unlockingScript: offerUnlockingScript },
        },
        options: { acceptDelayedBroadcast: false },
      })
      const txid = signed.txid
      const atomic = signed.tx ? Array.from(signed.tx) : undefined
      if (!txid || !atomic?.length)
        throw new Error('Signed market transaction missing')
      remember({ phase: 'signedUnknown', txid, atomicBeef: atomic })
      chart.send({ type: 'BROADCASTED' })
      remember({
        phase: 'broadcast',
        txid,
        atomicBeef: atomic,
      })
      const receiptDelivered = await deliverMarketSettlementWire({
        recipientIdentityKey: listing.seller,
        rootKeyHex: active.rootKeyHex,
        senderIdentityKey: active.identityKey,
        messagebox: sellerMessagebox,
        wire: {
          type: 'receipt',
          saleId,
          txid,
          atomicBeefB64: b64(atomic),
          ...(buyerMessagebox ? { buyerMessagebox } : {}),
        },
      })
      let broadcasted = true
      let receipt: MarketSettlementReceipt | undefined
      if (receiptDelivered) try {
        const receiptResponse = await waitForSellerResponse(
          saleId,
          'receipt-response',
          15_000
        )
        broadcasted =
          receiptResponse.txid.toLowerCase() === txid.toLowerCase() &&
          receiptResponse.broadcasted
        receipt = receiptResponse.receipt
      } catch {
        // BRC-33 is optional. Durable recovery will accept a later seller receipt.
      }
      if (
        receipt &&
        (receipt.settlementTxid.toLowerCase() !== txid.toLowerCase() ||
          !verifyMarketSettlementReceipt(receipt, args.intent))
      ) {
        throw new Error('Seller settlement receipt signature is invalid')
      }
      if (!broadcasted) throw new Error('Market transaction broadcast failed')
      chart.send({ type: 'COMMITTED' })
      remember({
        phase: 'committed',
        txid,
        atomicBeef: atomic,
      })
      if (receipt) removePending(saleId)
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
          name: 'Market collectable',
          origin: listing.origin,
          outpoint: `${txid}.0`,
        },
        status: 'complete',
      })
      scheduleHistoryBackupPush('market-purchase')
      return {
        saleId,
        status: receipt ? 'settled' : 'broadcast',
        txid,
        intent: args.intent,
        ...(receipt ? { receipt } : {}),
      }
    } catch (err) {
      const snapshot = chart.getSnapshot()
      if (mayAbortMarketPurchase(snapshot) && !pending.txid && !pending.atomicBeef?.length) {
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
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    } finally {
      chart.stop()
    }
  })
}

export async function recoverPendingMarketPurchases(): Promise<void> {
  const active = getActiveWallet()
  if (!active) return
  for (const record of readJson<PendingPurchase[]>(PENDING_KEY, [])) {
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
    try {
      await broadcastAtomicBeef(record.txid, record.atomicBeef)
    } catch (err) {
      console.warn(
        '[market] pending purchase rebroadcast skipped',
        record.saleId,
        err instanceof Error ? err.message : String(err),
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

export async function handleInboundMarketSettlementWire(args: {
  wire: MarketSettlementWire
  senderIdentityKey: string
  messagebox?: string
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
    const authorization = findMarketListingAuthorizationBySaleId(
      args.wire.saleId
    )
    if (
      !authorization ||
      authorization.reservationBuyer !== args.senderIdentityKey.toLowerCase()
    ) {
      return false
    }
    const atomic = decodeBeefB64(args.wire.atomicBeefB64)
    if (!atomic) return false
    let finalTx: Transaction
    try {
      const beef = Beef.fromBinary(atomic)
      finalTx = subjectTransaction(
        beef,
        authorization.listing?.outpoint ?? authorization.outpoint
      ).tx
    } catch {
      return false
    }
    if (
      finalTx.id('hex').toLowerCase() !== args.wire.txid.toLowerCase() ||
      marketSettlementCommitment(finalTx) !==
        authorization.reservationTxCommitment
    ) {
      return false
    }
    const intent = authorization.reservationIntent
    const listing = authorization.listing
    if (!intent || !listing || !verifyMarketPurchaseIntent(intent, listing)) {
      return false
    }
    const receipt = createMarketSettlementReceipt({
      intent,
      settlementTxid: args.wire.txid,
      sellerOutputIndex: 1,
      feeOutputIndex: 2,
    })
    const accepted = await broadcastAtomicBeef(args.wire.txid, atomic)
    if (!accepted && authorization.settlementTxid !== args.wire.txid.toLowerCase()) {
      return false
    }
    let progress = markMarketSettlementProgress({
      saleId: args.wire.saleId,
      settlementTxid: args.wire.txid,
    })
    const chart = createActor(marketSellerSettlementMachine).start()
    chart.send({
      type: 'START',
      listingKey: `${authorization.outpoint}:${authorization.nonce}`,
      buyerIdentityKey: intent.buyer,
      path: {
        settle: 'peerDeliver',
        buyerIdentityKey: intent.buyer,
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
    }
    chart.send({ type: 'PROCEEDS_INTERNALIZED' })
    if (!progress.itemRetired) {
      const retireErrors: string[] = []
      for (const spend of [
        { basket: '1sat', output: listing.outpoint.replace('_', '.') },
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
        return false
      }
      progress = markMarketSettlementProgress({
        saleId: args.wire.saleId,
        settlementTxid: args.wire.txid,
        itemRetired: true,
      })
    }
    chart.send({ type: 'ITEM_RETIRED' })
    if (progress.state !== 'settled') {
      updateMarketListingAuthorization({
        outpoint: authorization.outpoint,
        nonce: authorization.nonce,
        from: ['reserved'],
        to: 'settled',
        reason: args.wire.txid,
      })
    }
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
      return false
    }
    chart.stop()
    scheduleHistoryBackupPush('market-sale')
    if (listing) {
      const proceeds = calculateMarketSettlement(listing.priceSats).sellerSats
      recordAppActivity({
        origin: WALLET_ACTIVITY_ORIGIN,
        kind: 'spent',
        sats: 1,
        method: 'market-sale',
        note: 'Sold market collectable',
        txid: args.wire.txid,
        item: {
          name: 'Market collectable',
          origin: listing.origin,
          outpoint: listing.outpoint,
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
