import { P2PKH, PrivateKey } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import {
  chooseMarketReceiptAuthority,
  marketReceiptRefusalIsTerminal,
  verifyMarketSettlementPayout,
} from './marketReceiptAuthority'
import { calculateMarketSettlement } from './marketListing'
import type { MarketListingAdvert, MarketListingAuthorization } from './marketListing'

const BUYER = `02${'ab'.repeat(32)}`
const SELLER_IDENTITY = `02${'ee'.repeat(32)}`
const OTHER_BUYER = `03${'cd'.repeat(32)}`
const SETTLEMENT_TXID = 'ef'.repeat(32)
const sellerKey = PrivateKey.fromHex('1'.padStart(64, '0'))
const feeKey = PrivateKey.fromHex('2'.padStart(64, '0'))

function listing(): MarketListingAdvert {
  return {
    outpoint: `${'11'.repeat(32)}_0`,
    offerOutpoint: `${'11'.repeat(32)}_1`,
    offerLockingScript: '00',
    assetType: 'ordinal',
    seller: `02${'ee'.repeat(32)}`,
    payTo: sellerKey.toPublicKey().toAddress('mainnet'),
    priceSats: 10_000,
    feeIdentityKey: `02${'ff'.repeat(32)}`,
    feePayTo: feeKey.toPublicKey().toAddress('mainnet'),
    feeBasisPoints: 500,
    exactFeeSats: 500,
    depositSats: 1,
    origin: `${'22'.repeat(32)}_0`,
    provenanceHash: 'ab'.repeat(32),
    provenanceSize: 100,
    provenanceVersion: 2,
    listedAt: 1,
    expiresAt: null,
    nonce: 'cd'.repeat(16),
  } as MarketListingAdvert
}

function authorization(
  overrides: Partial<MarketListingAuthorization> = {},
): MarketListingAuthorization {
  const token = listing()
  return {
    key: `${token.outpoint}:${token.nonce}`,
    outpoint: token.outpoint,
    nonce: token.nonce,
    seller: token.seller,
    origin: token.origin,
    provenanceHash: token.provenanceHash,
    priceSats: token.priceSats,
    state: 'active',
    createdAt: 1,
    updatedAt: 1,
    listing: token,
    ...overrides,
  } as MarketListingAuthorization
}

function settlementOutputs(args?: {
  sellerSats?: number
  feeSats?: number
}): Array<{ satoshis: number; lockingScriptHex: string }> {
  const { sellerSats, feeSats } = calculateMarketSettlement(listing().priceSats)
  return [
    {
      satoshis: 1,
      lockingScriptHex: new P2PKH()
        .lock(
          PrivateKey.fromHex('3'.padStart(64, '0'))
            .toPublicKey()
            .toAddress('mainnet'),
        )
        .toHex(),
    },
    {
      satoshis: args?.sellerSats ?? sellerSats,
      lockingScriptHex: new P2PKH()
        .lock(sellerKey.toPublicKey().toAddress('mainnet'))
        .toHex(),
    },
    {
      satoshis: args?.feeSats ?? feeSats,
      lockingScriptHex: new P2PKH()
        .lock(feeKey.toPublicKey().toAddress('mainnet'))
        .toHex(),
    },
  ]
}

describe('chooseMarketReceiptAuthority', () => {
  it('accepts a list-time-unlock sale that was never reserved', () => {
    const authority = chooseMarketReceiptAuthority({
      senderIdentityKey: BUYER,
      activeIdentityKey: SELLER_IDENTITY,
      settlementTxid: SETTLEMENT_TXID,
      reserved: null,
      settledLocally: authorization(),
    })
    expect(authority).toMatchObject({ path: 'listTimeUnlocks' })
  })

  it('takes the reserved sign-hop path only with a commitment and intent', () => {
    const reserved = authorization({
      state: 'reserved',
      reservationSaleId: 'sale-1',
      reservationBuyer: BUYER.toLowerCase(),
      reservationTxCommitment: 'aa'.repeat(32),
      reservationIntent: { buyer: BUYER } as never,
    })
    expect(
      chooseMarketReceiptAuthority({
        senderIdentityKey: BUYER,
        activeIdentityKey: SELLER_IDENTITY,
        settlementTxid: SETTLEMENT_TXID,
        reserved,
        settledLocally: null,
      }),
    ).toMatchObject({ path: 'reservedBySignHop' })
    // An adopted list-time sale carries the sale id but no signed intent.
    expect(
      chooseMarketReceiptAuthority({
        senderIdentityKey: BUYER,
        activeIdentityKey: SELLER_IDENTITY,
        settlementTxid: SETTLEMENT_TXID,
        reserved: authorization({
          reservationSaleId: 'sale-1',
          reservationBuyer: BUYER.toLowerCase(),
        }),
        settledLocally: null,
      }),
    ).toMatchObject({ path: 'listTimeUnlocks' })
  })

  it('refuses another buyer, an unknown sale, a cancel, and a rival settlement', () => {
    expect(
      chooseMarketReceiptAuthority({
        senderIdentityKey: OTHER_BUYER,
        activeIdentityKey: SELLER_IDENTITY,
        settlementTxid: SETTLEMENT_TXID,
        reserved: authorization({
          reservationSaleId: 'sale-1',
          reservationBuyer: BUYER.toLowerCase(),
          reservationTxCommitment: 'aa'.repeat(32),
          reservationIntent: { buyer: BUYER } as never,
        }),
        settledLocally: null,
      }),
    ).toEqual({ path: 'refuse', reason: 'reservation-buyer-mismatch' })
    expect(
      chooseMarketReceiptAuthority({
        senderIdentityKey: BUYER,
        activeIdentityKey: SELLER_IDENTITY,
        settlementTxid: SETTLEMENT_TXID,
        reserved: null,
        settledLocally: null,
      }),
    ).toEqual({ path: 'refuse', reason: 'no-local-listing-for-sale' })
    expect(
      chooseMarketReceiptAuthority({
        senderIdentityKey: BUYER,
        activeIdentityKey: SELLER_IDENTITY,
        settlementTxid: SETTLEMENT_TXID,
        reserved: null,
        settledLocally: authorization({ state: 'cancelled' }),
      }),
    ).toEqual({ path: 'refuse', reason: 'listing-cancelled' })
    expect(
      chooseMarketReceiptAuthority({
        senderIdentityKey: BUYER,
        activeIdentityKey: SELLER_IDENTITY,
        settlementTxid: SETTLEMENT_TXID,
        reserved: null,
        settledLocally: authorization({ settlementTxid: 'ab'.repeat(32) }),
      }),
    ).toEqual({ path: 'refuse', reason: 'listing-settled-by-another-tx' })
  })

  it('refuses a listing that belongs to another local account', () => {
    expect(
      chooseMarketReceiptAuthority({
        senderIdentityKey: BUYER,
        activeIdentityKey: OTHER_BUYER,
        settlementTxid: SETTLEMENT_TXID,
        reserved: null,
        settledLocally: authorization(),
      }),
    ).toEqual({ path: 'refuse', reason: 'listing-not-sold-by-active-account' })
  })

  it('replays the same settlement idempotently', () => {
    expect(
      chooseMarketReceiptAuthority({
        senderIdentityKey: BUYER,
        activeIdentityKey: SELLER_IDENTITY,
        settlementTxid: SETTLEMENT_TXID.toUpperCase(),
        reserved: null,
        settledLocally: authorization({ settlementTxid: SETTLEMENT_TXID }),
      }),
    ).toMatchObject({ path: 'listTimeUnlocks' })
  })
})

describe('verifyMarketSettlementPayout', () => {
  const token = listing()

  it('accepts a settlement that spends item plus offer and pays seller and fee', () => {
    const payout = verifyMarketSettlementPayout({
      listing: token,
      spentOutpoints: [token.outpoint, token.offerOutpoint, `${'99'.repeat(32)}.4`],
      outputs: settlementOutputs(),
    })
    expect(payout).toMatchObject({
      ok: true,
      sellerOutputIndex: 1,
      feeOutputIndex: 2,
      sellerSats: calculateMarketSettlement(token.priceSats).sellerSats,
    })
  })

  it('refuses a missing item input, a missing offer input, and a short payment', () => {
    expect(
      verifyMarketSettlementPayout({
        listing: token,
        spentOutpoints: [token.offerOutpoint],
        outputs: settlementOutputs(),
      }),
    ).toEqual({ ok: false, reason: 'settlement-missing-item-input' })
    expect(
      verifyMarketSettlementPayout({
        listing: token,
        spentOutpoints: [token.outpoint],
        outputs: settlementOutputs(),
      }),
    ).toEqual({ ok: false, reason: 'settlement-missing-offer-input' })
    expect(
      verifyMarketSettlementPayout({
        listing: token,
        spentOutpoints: [token.outpoint, token.offerOutpoint],
        outputs: settlementOutputs({ sellerSats: 10 }),
      }),
    ).toEqual({ ok: false, reason: 'seller-payment-mismatch' })
    expect(
      verifyMarketSettlementPayout({
        listing: token,
        spentOutpoints: [token.outpoint, token.offerOutpoint],
        outputs: settlementOutputs({ feeSats: 1 }),
      }),
    ).toEqual({ ok: false, reason: 'fee-payment-mismatch' })
  })
})

describe('marketReceiptRefusalIsTerminal', () => {
  it('keeps a receipt whose listing may still arrive', () => {
    expect(marketReceiptRefusalIsTerminal('no-local-listing-for-sale')).toBe(false)
    expect(marketReceiptRefusalIsTerminal('listing-not-sold-by-active-account')).toBe(
      false,
    )
  })

  it('consumes a receipt no amount of waiting can make valid', () => {
    for (const reason of [
      'listing-has-no-token',
      'listing-cancelled',
      'listing-settled-by-another-tx',
      'reservation-buyer-mismatch',
      'settlement-missing-item-input',
      'settlement-missing-offer-input',
      'seller-payment-mismatch',
      'fee-payment-mismatch',
    ] as const) {
      expect(marketReceiptRefusalIsTerminal(reason)).toBe(true)
    }
  })
})
