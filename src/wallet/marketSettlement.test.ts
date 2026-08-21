import {
  Beef,
  LockingScript,
  P2PKH,
  PrivateKey,
  PublicKey,
  Transaction,
  UnlockingScript,
} from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import type { MarketListingAdvert } from './marketListing'
import {
  marketSettlementCommitment,
  mergePendingPurchase,
  validateMarketSettlementOutputs,
} from './marketSettlement'
import {
  encodeMarketOffer,
  MARKET_OFFER_MAGIC,
  type MarketOfferFields,
} from './marketOverlayProtocol'
import {
  MARKET_FEE_BASIS_POINTS,
  MARKET_FEE_IDENTITY_KEY,
  MARKET_FEE_PAY_TO_ADDRESS,
} from './walletConfig'

function fixture() {
  const sellerKey = PrivateKey.fromHex('1'.padStart(64, '0'))
  const seller = sellerKey.toPublicKey()
  const fee = PublicKey.fromString(MARKET_FEE_IDENTITY_KEY)
  const buyer = PrivateKey.fromHex('3'.padStart(64, '0')).toPublicKey()
  const fields: MarketOfferFields = {
    magic: MARKET_OFFER_MAGIC,
    version: 1,
    itemVout: 0,
    sellerIdentityKey: seller.toString(),
    payTo: seller.toAddress(),
    grossPriceSats: 101,
    feeIdentityKey: fee.toString(),
    feePayTo: MARKET_FEE_PAY_TO_ADDRESS,
    feeBasisPoints: MARKET_FEE_BASIS_POINTS,
    exactFeeSats: Math.floor((101 * MARKET_FEE_BASIS_POINTS) / 10_000),
    provenanceHash: 'ef'.repeat(32),
    provenanceSize: 123,
    provenanceVersion: 2,
    expiresAt: Date.now() + 60_000,
    nonce: '01'.repeat(16),
    depositSats: 1,
    messagebox: 'https://seller.example/v1/messagebox',
  }
  const offerLockingScript = encodeMarketOffer(fields, sellerKey)
  const listingTx = new Transaction()
  listingTx.addOutput({
    satoshis: 1,
    lockingScript: new P2PKH().lock(seller.toAddress()),
  })
  listingTx.addOutput({
    satoshis: 1,
    lockingScript: LockingScript.fromHex(offerLockingScript),
  })
  const fundingTx = new Transaction()
  fundingTx.addOutput({
    satoshis: 111,
    lockingScript: new P2PKH().lock(buyer.toAddress()),
  })
  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: listingTx,
    sourceOutputIndex: 0,
    unlockingScript: new UnlockingScript(),
  })
  tx.addInput({
    sourceTransaction: listingTx,
    sourceOutputIndex: 1,
    unlockingScript: new UnlockingScript(),
  })
  tx.addInput({
    sourceTransaction: fundingTx,
    sourceOutputIndex: 0,
    unlockingScript: new UnlockingScript(),
  })
  tx.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(buyer.toAddress()) })
  tx.addOutput({ satoshis: 97, lockingScript: new P2PKH().lock(seller.toAddress()) })
  tx.addOutput({
    satoshis: fields.exactFeeSats,
    lockingScript: new P2PKH().lock(MARKET_FEE_PAY_TO_ADDRESS),
  })
  tx.addOutput({ satoshis: 9, lockingScript: new P2PKH().lock(buyer.toAddress()) })
  const beef = new Beef()
  beef.mergeTransaction(listingTx)
  beef.mergeTransaction(fundingTx)
  beef.mergeTransaction(tx)
  const listing: MarketListingAdvert = {
    outpoint: `${listingTx.id('hex')}_0`,
    offerOutpoint: `${listingTx.id('hex')}_1`,
    offerLockingScript,
    assetType: 'ordinal',
    seller: fields.sellerIdentityKey,
    payTo: fields.payTo,
    priceSats: fields.grossPriceSats,
    feeIdentityKey: fields.feeIdentityKey,
    feePayTo: fields.feePayTo,
    feeBasisPoints: fields.feeBasisPoints,
    exactFeeSats: fields.exactFeeSats,
    depositSats: 1,
    messagebox: fields.messagebox,
    origin: `${'cd'.repeat(32)}_0`,
    provenanceHash: fields.provenanceHash,
    provenanceSize: fields.provenanceSize,
    provenanceVersion: 2,
    listedAt: Date.now(),
    expiresAt: fields.expiresAt,
    nonce: fields.nonce,
  }
  const validate = () =>
    validateMarketSettlementOutputs({
      tx,
      beef,
      listing,
      buyerIdentityKey: buyer.toString(),
      chain: 'main',
      itemVin: 0,
      offerVin: 1,
      itemOutputIndex: 0,
      sellerOutputIndex: 1,
      feeOutputIndex: 2,
    })
  return { tx, listing, validate, buyer, seller, fee }
}

describe('market exact settlement contract', () => {
  it('accepts item+offer inputs, deposit refund, exact fee, and buyer-only change', () => {
    const { tx, validate } = fixture()
    expect(validate).not.toThrow()
    expect(marketSettlementCommitment(tx)).toHaveLength(64)
  })

  it.each([
    ['buyer item', 0, 2],
    ['seller proceeds/deposit', 1, 96],
    ['exact fee', 2, 4],
  ])('rejects %s amount tampering', (_name, vout, sats) => {
    const { tx, validate } = fixture()
    tx.outputs[vout]!.satoshis = sats
    expect(validate).toThrow(/outputs do not match/i)
  })

  it('rejects foreign change, duplicate seller inputs, and swapped item/offer', () => {
    const foreign = fixture()
    foreign.tx.outputs[3]!.lockingScript = new P2PKH().lock(
      PrivateKey.fromRandom().toPublicKey().toAddress(),
    )
    expect(foreign.validate).toThrow(/non-buyer change/i)

    const duplicate = fixture()
    duplicate.tx.inputs[2]!.sourceTXID = duplicate.tx.inputs[0]!.sourceTXID
    duplicate.tx.inputs[2]!.sourceOutputIndex = 0
    expect(duplicate.validate).toThrow(/duplicate/i)

    const swapped = fixture()
    ;[swapped.tx.inputs[0], swapped.tx.inputs[1]] = [
      swapped.tx.inputs[1]!,
      swapped.tx.inputs[0]!,
    ]
    expect(swapped.validate).toThrow(/ordering/i)
  })

  it('never drops a signed txid or AtomicBEEF when entering recovery', () => {
    const previous = {
      saleId: 'sale',
      reference: 'ref',
      itemVin: 0,
      offerVin: 1,
      phase: 'broadcast' as const,
      txid: 'ab'.repeat(32),
      atomicBeef: [1, 2, 3],
      expiresAt: Date.now() + 60_000,
      sellerIdentityKey: '03'.repeat(33),
      intent: {} as never,
    }
    const recovered = mergePendingPurchase(previous, { phase: 'recovery' })
    expect(recovered.phase).toBe('recovery')
    expect(recovered.txid).toBe(previous.txid)
    expect(recovered.atomicBeef).toEqual([1, 2, 3])
  })
})
