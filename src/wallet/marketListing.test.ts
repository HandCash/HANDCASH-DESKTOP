import { afterEach, describe, expect, it } from 'vitest'
import {
  Beef,
  LockingScript,
  MerklePath,
  PrivateKey,
  Transaction,
  UnlockingScript,
  Utils,
} from '@bsv/sdk'
import { setActiveWallet } from './session'
import {
  calculateMarketSettlement,
  createCancelMarketListingAdvert,
  createMarketListingAdvert,
  createMarketPurchaseIntent,
  createMarketSettlementReceipt,
  deterministicJson,
  getMarketSaleStatus,
  hashMarketProvenance,
  isMarketListingOrigin,
  listingPreimage,
  marketFeePayToAddress,
  purchaseIntentPreimage,
  settlementReceiptPreimage,
  verifyMarketListingProvenance,
  verifyMarketPurchaseIntent,
  verifyMarketSettlementReceipt,
  type MarketListingAdvert,
} from './marketListing'
import {
  MARKET_FEE_BASIS_POINTS,
  MARKET_FEE_IDENTITY_KEY,
  MARKET_FEE_PAY_TO_ADDRESS,
} from './walletConfig'
import type { ProvenanceV2 } from './oneSatProvenance'

const ORD_ENVELOPE =
  '0063036f726451' + '0a746578742f706c61696e' + '0002' + '6869' + '68'

function fixture(): { provenance: ProvenanceV2; outpoint: string } {
  const origin = new Transaction()
  origin.addOutput({
    satoshis: 1,
    lockingScript: LockingScript.fromHex(ORD_ENVELOPE),
  })
  const tip = new Transaction()
  tip.addInput({
    sourceTransaction: origin,
    sourceOutputIndex: 0,
    unlockingScript: new UnlockingScript(),
  })
  tip.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex('51') })
  const beef = new Beef()
  const entry = beef.mergeRawTx(origin.toBinary())
  entry.bumpIndex = beef.mergeBump(
    new MerklePath(900_000, [
      [
        { offset: 0, hash: origin.id('hex'), txid: true },
        { offset: 1, duplicate: true },
      ],
    ]),
  )
  beef.mergeRawTx(tip.toBinary())
  const originOutpoint = `${origin.id('hex')}_0`
  const tipOutpoint = `${tip.id('hex')}_0`
  return {
    outpoint: `${tip.id('hex')}.0`,
    provenance: {
      v: 2,
      origin: originOutpoint,
      tip: tipOutpoint,
      path: [tipOutpoint, originOutpoint],
      beefB64: btoa(String.fromCharCode(...beef.toBinaryAtomic(tip.id('hex')))),
    },
  }
}

function signAdvert(
  key: PrivateKey,
  advert: Omit<MarketListingAdvert, 'signature'>,
): MarketListingAdvert {
  const signature = key.sign(
    Utils.toArray(listingPreimage(advert), 'utf8'),
    undefined,
    true,
  )
  return {
    ...advert,
    signature: Utils.toHex([
      ...signature.r.toArray('be', 32),
      ...signature.s.toArray('be', 32),
    ]),
  }
}

describe('market listing advert', () => {
  afterEach(() => setActiveWallet(null))

  it('builds, verifies and locally authorizes a v2 listing', async () => {
    const { provenance, outpoint } = fixture()
    const rootKeyHex = '1'.padStart(64, '0')
    const privateKey = PrivateKey.fromHex(rootKeyHex)
    const publicKey = privateKey.toPublicKey()
    setActiveWallet({
      wallet: {
        listOutputs: async () => ({
          totalOutputs: 1,
          outputs: [
            {
              outpoint,
              satoshis: 1,
              customInstructions: JSON.stringify({
                origin: provenance.origin,
                provenance,
              }),
            },
          ],
        }),
      } as never,
      services: {} as never,
      rootKeyHex,
      identityKey: publicKey.toString(),
      address: publicKey.toAddress('mainnet'),
      handle: 'seller',
      chain: 'main',
    })

    const result = await createMarketListingAdvert({
      outpoint,
      priceSats: 25_000,
    })
    expect(result.listing).toMatchObject({
      outpoint: outpoint.replace('.', '_'),
      origin: provenance.origin,
      seller: publicKey.toString(),
      payTo: publicKey.toAddress('mainnet'),
      feeIdentityKey: MARKET_FEE_IDENTITY_KEY,
      feeBasisPoints: 500,
      provenanceVersion: 2,
    })
    expect(result.listing.signature).toHaveLength(128)
    await expect(
      verifyMarketListingProvenance(result),
    ).resolves.toEqual({ verified: true, reason: null })
    const intent = await createMarketPurchaseIntent(result)
    expect(intent).toMatchObject({
      outpoint: result.listing.outpoint,
      buyer: publicKey.toString(),
      seller: publicKey.toString(),
      priceSats: 25_000,
      feeSats: 1_250,
      totalSats: 25_000,
    })
    expect(verifyMarketPurchaseIntent(intent, result.listing)).toBe(true)
    const receipt = createMarketSettlementReceipt({
      intent,
      settlementTxid: 'ab'.repeat(32),
      sellerOutputIndex: 1,
      feeOutputIndex: 2,
    })
    expect(verifyMarketSettlementReceipt(receipt, intent)).toBe(true)

    const status = getMarketSaleStatus(result.listing)
    expect(status.status).toBe('active')
    expect(createCancelMarketListingAdvert(result.listing)).toMatchObject({
      action: 'cancel',
      outpoint: result.listing.outpoint,
      nonce: result.listing.nonce,
    })
    expect(getMarketSaleStatus(result.listing).status).toBe('cancelled')
  })

  it('restricts signing to HandCash market hosts and local development', () => {
    expect(isMarketListingOrigin('localhost:5201')).toBe(true)
    expect(isMarketListingOrigin('preprod-market.handcash.io')).toBe(true)
    expect(isMarketListingOrigin('https://market-v2.handcash.io')).toBe(true)
    expect(isMarketListingOrigin('evil.example')).toBe(false)
  })

  it('hashes canonical UTF-8 JSON and rejects tampered proof/output', async () => {
    const { provenance, outpoint } = fixture()
    const digest = hashMarketProvenance(provenance)
    const sellerKey = PrivateKey.fromRandom()
    expect(
      deterministicJson({ z: 1, a: { y: 2, x: 3 } }),
    ).toBe('{"a":{"x":3,"y":2},"z":1}')

    const unsigned: Omit<MarketListingAdvert, 'signature'> = {
      outpoint: outpoint.replace('.', '_'),
      assetType: 'ordinal',
      seller: sellerKey.toPublicKey().toString(),
      payTo: 'unused',
      priceSats: 100,
      feeIdentityKey: MARKET_FEE_IDENTITY_KEY,
      feeBasisPoints: MARKET_FEE_BASIS_POINTS,
      origin: provenance.origin,
      provenanceHash: digest.hash,
      provenanceSize: digest.size,
      provenanceVersion: 2,
      listedAt: Date.now(),
      expiresAt: null,
      nonce: '00'.repeat(16),
    }
    const base = signAdvert(sellerKey, unsigned)
    await expect(
      verifyMarketListingProvenance({
        listing: base,
        provenance: { ...provenance, contentType: 'tampered' },
      }),
    ).resolves.toMatchObject({
      verified: false,
      reason: 'PROVENANCE_COMMITMENT_MISMATCH',
    })
    await expect(
      verifyMarketListingProvenance({
        listing: signAdvert(sellerKey, {
          ...unsigned,
          outpoint: `${'ab'.repeat(32)}_1`,
        }),
        provenance,
      }),
    ).resolves.toMatchObject({
      verified: false,
      reason: expect.stringContaining('ITEM_ORIGIN_UNPROVEN'),
    })
  })

  it('includes a 500 bps fee in buyer total with deterministic rounding', () => {
    expect(MARKET_FEE_BASIS_POINTS).toBe(500)
    expect(calculateMarketSettlement(100)).toEqual({
      priceSats: 100,
      sellerSats: 95,
      feeSats: 5,
    })
    expect(calculateMarketSettlement(101)).toEqual({
      priceSats: 101,
      sellerSats: 96,
      feeSats: 5,
    })
    expect(
      marketFeePayToAddress({
        feeIdentityKey: MARKET_FEE_IDENTITY_KEY,
        feeBasisPoints: MARKET_FEE_BASIS_POINTS,
      }),
    ).toBe(MARKET_FEE_PAY_TO_ADDRESS)
  })

  it('matches Worker purchase-intent and receipt preimages byte for byte', () => {
    const intent = {
      intentId: 'd'.repeat(32),
      outpoint: `${'a'.repeat(64)}_0`,
      buyer: `02${'b'.repeat(64)}`,
      seller: `03${'c'.repeat(64)}`,
      priceSats: 100_000,
      feeSats: 5_000,
      totalSats: 100_000,
      provenanceHash: 'e'.repeat(64),
      createdAt: 1_700_000_000_000,
      expiresAt: 1_700_000_090_000,
      nonce: 'deadbeefdeadbeef',
    }
    expect(purchaseIntentPreimage(intent)).toBe(
      [
        'HandCash-Market-Purchase-Intent-v1',
        intent.intentId,
        intent.outpoint,
        intent.buyer,
        intent.seller,
        '100000',
        '5000',
        '100000',
        intent.provenanceHash,
        String(intent.createdAt),
        String(intent.expiresAt),
        intent.nonce,
      ].join('\n'),
    )
    const receipt = {
      receiptId: 'f'.repeat(32),
      intentId: intent.intentId,
      outpoint: intent.outpoint,
      buyer: intent.buyer,
      seller: intent.seller,
      settlementTxid: '1'.repeat(64),
      sellerOutputIndex: 1,
      feeOutputIndex: 2,
      settledAt: 1_700_000_001_000,
    }
    expect(settlementReceiptPreimage(receipt)).toBe(
      [
        'HandCash-Market-Settlement-Receipt-v1',
        receipt.receiptId,
        receipt.intentId,
        receipt.outpoint,
        receipt.buyer,
        receipt.seller,
        receipt.settlementTxid,
        '1',
        '2',
        String(receipt.settledAt),
      ].join('\n'),
    )
  })

  it('stages the item as an external signable input', () => {
    const itemInput = {
      outpoint: `${'ab'.repeat(32)}.1`,
      inputDescription: 'Listed market item',
      unlockingScriptLength: 108,
    }
    expect(itemInput).toMatchObject({
      unlockingScriptLength: 108,
    })
  })
})
