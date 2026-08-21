/**
 * Exhaustive market settlement decisions. There is deliberately no
 * broadcast-first or split-payment fallback.
 */
export type MarketPurchasePath =
  | {
      path: 'atomicPeerSettlement'
      sellerIdentityKey: string
      feeIdentityKey: string
    }
  | {
      path: 'refuse'
      reason:
        | 'invalid-advert'
        | 'unproven-origin'
        | 'listing-unavailable'
    }

export type MarketSellerSettlePath =
  | {
      settle: 'peerDeliver'
      buyerIdentityKey: string
      listingKey: string
    }
  | {
      settle: 'refuse'
      reason:
        | 'listing-not-authorized'
        | 'listing-not-active'
        | 'terms-mismatch'
        | 'competing-buyer'
        | 'duplicate-request'
        | 'timeout'
    }

export function chooseMarketPurchasePath(args: {
  advertValid: boolean
  provenanceValid: boolean
  listingAvailable: boolean
  sellerIdentityKey: string
  feeIdentityKey: string
}): MarketPurchasePath {
  if (!args.advertValid) return { path: 'refuse', reason: 'invalid-advert' }
  if (!args.provenanceValid) return { path: 'refuse', reason: 'unproven-origin' }
  if (!args.listingAvailable) {
    return { path: 'refuse', reason: 'listing-unavailable' }
  }
  return {
    path: 'atomicPeerSettlement',
    sellerIdentityKey: args.sellerIdentityKey,
    feeIdentityKey: args.feeIdentityKey,
  }
}

export function chooseMarketSellerSettlePath(args: {
  listingAuthorized: boolean
  listingActive: boolean
  termsMatch: boolean
  duplicate: boolean
  competingBuyer: boolean
  timedOut: boolean
  buyerIdentityKey: string
  listingKey: string
}): MarketSellerSettlePath {
  if (!args.listingAuthorized) {
    return { settle: 'refuse', reason: 'listing-not-authorized' }
  }
  if (!args.listingActive) {
    return { settle: 'refuse', reason: 'listing-not-active' }
  }
  if (!args.termsMatch) return { settle: 'refuse', reason: 'terms-mismatch' }
  if (args.duplicate) return { settle: 'refuse', reason: 'duplicate-request' }
  if (args.competingBuyer) {
    return { settle: 'refuse', reason: 'competing-buyer' }
  }
  if (args.timedOut) return { settle: 'refuse', reason: 'timeout' }
  return {
    settle: 'peerDeliver',
    buyerIdentityKey: args.buyerIdentityKey,
    listingKey: args.listingKey,
  }
}
