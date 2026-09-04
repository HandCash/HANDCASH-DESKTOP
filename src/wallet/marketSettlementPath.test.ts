import { describe, expect, it } from 'vitest'
import {
  chooseMarketPurchasePath,
  chooseMarketSellerSettlePath,
} from './marketSettlementPath'

describe('chooseMarketPurchasePath', () => {
  const keys = {
    sellerIdentityKey: '02' + 'ab'.repeat(32),
    feeIdentityKey: '03' + 'cd'.repeat(32),
  }

  it('refuses invalid advert / provenance / availability first', () => {
    expect(
      chooseMarketPurchasePath({
        advertValid: false,
        provenanceValid: true,
        listingAvailable: true,
        ...keys,
      }),
    ).toEqual({ path: 'refuse', reason: 'invalid-advert' })
    expect(
      chooseMarketPurchasePath({
        advertValid: true,
        provenanceValid: false,
        listingAvailable: true,
        ...keys,
      }),
    ).toEqual({ path: 'refuse', reason: 'unproven-origin' })
    expect(
      chooseMarketPurchasePath({
        advertValid: true,
        provenanceValid: true,
        listingAvailable: false,
        ...keys,
      }),
    ).toEqual({ path: 'refuse', reason: 'listing-unavailable' })
  })

  it('selects atomic peer settlement when gates pass', () => {
    expect(
      chooseMarketPurchasePath({
        advertValid: true,
        provenanceValid: true,
        listingAvailable: true,
        ...keys,
      }),
    ).toEqual({ path: 'atomicPeerSettlement', ...keys })
  })
})

describe('chooseMarketSellerSettlePath', () => {
  const peer = {
    buyerIdentityKey: '02' + '11'.repeat(32),
    listingKey: 'listing-1',
  }

  it('refuses in priority order', () => {
    expect(
      chooseMarketSellerSettlePath({
        listingAuthorized: false,
        listingActive: true,
        termsMatch: true,
        duplicate: false,
        competingBuyer: false,
        timedOut: false,
        ...peer,
      }),
    ).toEqual({ settle: 'refuse', reason: 'listing-not-authorized' })
    expect(
      chooseMarketSellerSettlePath({
        listingAuthorized: true,
        listingActive: false,
        termsMatch: true,
        duplicate: false,
        competingBuyer: false,
        timedOut: false,
        ...peer,
      }),
    ).toEqual({ settle: 'refuse', reason: 'listing-not-active' })
  })

  it('selects peerDeliver when gates pass', () => {
    expect(
      chooseMarketSellerSettlePath({
        listingAuthorized: true,
        listingActive: true,
        termsMatch: true,
        duplicate: false,
        competingBuyer: false,
        timedOut: false,
        ...peer,
      }),
    ).toEqual({ settle: 'peerDeliver', ...peer })
  })
})
