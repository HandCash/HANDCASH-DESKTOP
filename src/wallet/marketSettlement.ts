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
import { marketPurchaseMachine } from '../machines/marketPurchaseMachine'
import { marketSellerSettlementMachine } from '../machines/marketSellerSettlementMachine'
import { getBeefForTxidCached } from './beefCache'
import {
  calculateMarketSettlement,
  createMarketSettlementReceipt,
  findMarketListingAuthorizationBySaleId,
  getMarketListingAuthorization,
  marketFeePayToAddress,
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

const PENDING_KEY = 'handcash.market.pending.v2'
const RESPONSE_KEY = 'handcash.market.responses.v2'
const SETTLEMENT_TIMEOUT_MS = 90_000

type PendingPurchase = {
  saleId: string
  reference: string
  itemVin: number
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
  listing: MarketListingAdvert
  buyerIdentityKey: string
  chain: 'main' | 'test'
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
    const inputBeef = (await getBeefForTxidCached(active, itemTxid!)).toBinary()
    const created = await active.wallet.createAction({
      description: 'Buy market collectable',
      labels: ['market-v2', '1sat'],
      inputBEEF: inputBeef,
      inputs: [
        {
          outpoint: normalizeOutpoint(listing.outpoint),
          inputDescription: 'Listed market item',
          unlockingScriptLength: 108,
        },
      ],
      outputs: [
        {
          lockingScript: buyerLock,
          satoshis: 1,
          outputDescription: 'Market item to buyer',
          basket: '1sat',
          tags: ['ordinal', `origin:${listing.origin.replace('_', '.')}`],
          customInstructions: buildCollectableCustomInstructions({
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
    const sellerMessagebox = args.sellerMessagebox
    const buyerMessagebox = args.buyerMessagebox
    const pending: PendingPurchase = {
      saleId,
      reference: signable.reference,
      itemVin,
      expiresAt: Date.now() + SETTLEMENT_TIMEOUT_MS,
      sellerIdentityKey: listing.seller,
      intent: args.intent,
      ...(sellerMessagebox ? { sellerMessagebox } : {}),
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
      const signed = await active.wallet.signAction({
        reference: signable.reference,
        spends: { [itemVin]: { unlockingScript: response.unlockingScript } },
        options: { noSend: true },
      })
      const txid = signed.txid
      const atomic = signed.tx ? Array.from(signed.tx) : undefined
      if (!txid || !atomic?.length)
        throw new Error('Signed market transaction missing')
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
      if (!receiptDelivered) throw new Error('Seller receipt delivery failed')
      chart.send({ type: 'DELIVERED' })
      let broadcasted = false
      let receipt: MarketSettlementReceipt | undefined
      try {
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
        // Seller received the exact signed BEEF but did not confirm in time.
      }
      if (
        receipt &&
        (receipt.settlementTxid.toLowerCase() !== txid.toLowerCase() ||
          !verifyMarketSettlementReceipt(receipt, args.intent))
      ) {
        throw new Error('Seller settlement receipt signature is invalid')
      }
      if (!broadcasted) {
        broadcasted = await broadcastAtomicBeef(txid, atomic)
      }
      if (!broadcasted) throw new Error('Market transaction broadcast failed')
      chart.send({ type: 'BROADCASTED' })
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
      await active.wallet
        .abortAction({ reference: signable.reference })
        .catch(() => {})
      removePending(saleId)
      chart.send({
        type: 'FAIL',
        error: err instanceof Error ? err.message : String(err),
      })
      chart.send({ type: 'ABORTED' })
      throw err
    } finally {
      chart.stop()
    }
  })
}

export async function recoverMarketSettlementReceipt(args: {
  intent: MarketPurchaseIntent
}): Promise<MarketSettlementReceipt | null> {
  const active = getActiveWallet()
  if (!active) throw new Error('Wallet locked')
  const pending = readJson<PendingPurchase[]>(PENDING_KEY, []).find(
    (item) =>
      item.saleId === args.intent.intentId &&
      item.sellerIdentityKey.toLowerCase() === args.intent.seller.toLowerCase()
  )
  if (!pending) return null
  await pollInboundTipHints({ rootKeyHex: active.rootKeyHex })
  const response = takeResponse(
    args.intent.intentId,
    'receipt-response'
  ) as Extract<StoredResponse, { type: 'receipt-response' }> | null
  const receipt = response?.receipt
  if (
    !receipt ||
    !verifyMarketSettlementReceipt(receipt, args.intent) ||
    receipt.settlementTxid.toLowerCase() !== response.txid.toLowerCase()
  ) {
    return null
  }
  removePending(args.intent.intentId)
  return receipt
}

async function signSellerItemInput(args: {
  wire: Extract<MarketSettlementWire, { type: 'sign-request' }>
  senderIdentityKey: string
}): Promise<string> {
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
  const source =
    tx.inputs[vin]?.sourceTransaction ??
    beef.findTxid(String(tx.inputs[vin]?.sourceTXID))?.tx
  const sourceOutput = source?.outputs[tx.inputs[vin]!.sourceOutputIndex]
  if (!sourceOutput || sourceOutput.satoshis !== 1) {
    throw new Error('Listed source output is not one satoshi')
  }
  validateMarketSettlementOutputs({
    tx,
    listing,
    buyerIdentityKey: args.wire.buyerIdentityKey,
    chain: active.chain,
    itemOutputIndex: args.wire.itemOutputIndex,
    sellerOutputIndex: args.wire.sellerOutputIndex,
    feeOutputIndex: args.wire.feeOutputIndex,
  })
  const seenInputs = new Set<string>()
  let inputSatoshis = 0
  for (const input of tx.inputs) {
    const point = `${String(input.sourceTXID).toLowerCase()}.${
      input.sourceOutputIndex
    }`
    if (seenInputs.has(point)) throw new Error('Duplicate settlement input')
    seenInputs.add(point)
    const sourceTx =
      input.sourceTransaction ?? beef.findTxid(String(input.sourceTXID))?.tx
    const sourceOut = sourceTx?.outputs[input.sourceOutputIndex]
    const sourceSatoshis = sourceOut?.satoshis
    if (
      !sourceOut ||
      typeof sourceSatoshis !== 'number' ||
      !Number.isSafeInteger(sourceSatoshis)
    ) {
      throw new Error(`Settlement input source is missing: ${point}`)
    }
    inputSatoshis += sourceSatoshis
  }
  const outputSatoshis = tx.outputs.reduce(
    (sum, output) => sum + (output.satoshis ?? 0),
    0
  )
  if (inputSatoshis < outputSatoshis) {
    throw new Error('Settlement outputs exceed all validated inputs')
  }
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
  await tx.sign()
  const unlockingScript = tx.inputs[vin]!.unlockingScript?.toHex()
  if (!unlockingScript) throw new Error('Seller item signature missing')
  return unlockingScript
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
    const responseDelivered = await deliverMarketSettlementWire({
      wire: {
        type: 'receipt-response',
        saleId: args.wire.saleId,
        txid: args.wire.txid,
        broadcasted: accepted,
        receipt,
        ...(!accepted ? { reason: 'Seller broadcast failed' } : {}),
      },
      recipientIdentityKey: args.senderIdentityKey,
      rootKeyHex: active.rootKeyHex,
      senderIdentityKey: active.identityKey,
      messagebox: args.wire.buyerMessagebox,
    })
    if (!accepted || !responseDelivered) return false
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
    chart.send({ type: 'ITEM_INPUT_SIGNED' })
    chart.send({ type: 'DELIVERED' })
    chart.send({ type: 'BROADCAST_CONFIRMED' })
    chart.stop()
    updateMarketListingAuthorization({
      outpoint: authorization.outpoint,
      nonce: authorization.nonce,
      from: ['reserved'],
      to: 'settled',
      reason: args.wire.txid,
    })
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
    const unlockingScript = await signSellerItemInput({
      wire: args.wire,
      senderIdentityKey: args.senderIdentityKey,
    })
    chart.send({ type: 'ITEM_INPUT_SIGNED' })
    response = {
      type: 'sign-response',
      saleId: args.wire.saleId,
      accepted: true,
      unlockingScript,
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
