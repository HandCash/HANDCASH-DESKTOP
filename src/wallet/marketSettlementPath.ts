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

export type MarketReceiptDeliveryPath =
  | { path: 'localSellerReconcile' }
  | { path: 'messageboxDelivery'; sellerIdentityKey: string }

export type MarketReceiptBroadcastPath =
  | { broadcast: 'alreadyConfirmedByLocalBuyer' }
  | { broadcast: 'sellerPostBeef' }

export type PendingMarketReceiptPath =
  | { path: 'skip'; reason: 'foreign-buyer-account' }
  | { path: 'localSellerReconcile' }
  | { path: 'messageboxDelivery'; sellerIdentityKey: string }

/**
 * Telling the overlay a listing is sold. This is catalog hygiene, never custody:
 * a refused announce leaves the settled tx alone and only delays de-listing.
 */
export type MarketSoldAnnouncePath =
  | {
      announce: 'overlaySubmit'
      /** BRC-22 host that admitted the offer. */
      host: string
      topic: string
      /** `classifyLifecycle` refuses a settlement without buyer context. */
      buyerIdentityKey: string
    }
  | {
      announce: 'skip'
      reason:
        | 'no-host'
        | 'no-settlement-beef'
        | 'buyer-identity-unknown'
    }

export function chooseMarketSoldAnnouncePath(args: {
  host: string | null | undefined
  topic: string
  buyerIdentityKey: string | null | undefined
  settlementBeefBytes: number
}): MarketSoldAnnouncePath {
  const host = args.host?.trim().replace(/\/+$/, '') ?? ''
  if (!host) return { announce: 'skip', reason: 'no-host' }
  if (args.settlementBeefBytes <= 0) {
    return { announce: 'skip', reason: 'no-settlement-beef' }
  }
  const buyerIdentityKey = args.buyerIdentityKey?.trim().toLowerCase() ?? ''
  if (!/^(02|03)[0-9a-f]{64}$/.test(buyerIdentityKey)) {
    return { announce: 'skip', reason: 'buyer-identity-unknown' }
  }
  return {
    announce: 'overlaySubmit',
    host,
    topic: args.topic,
    buyerIdentityKey,
  }
}

/** A wallet buying its own listing settles both roles locally and atomically. */
export function chooseMarketReceiptDeliveryPath(args: {
  buyerIdentityKey: string
  sellerIdentityKey: string
}): MarketReceiptDeliveryPath {
  if (
    args.buyerIdentityKey.trim().toLowerCase() ===
    args.sellerIdentityKey.trim().toLowerCase()
  ) {
    return { path: 'localSellerReconcile' }
  }
  return {
    path: 'messageboxDelivery',
    sellerIdentityKey: args.sellerIdentityKey,
  }
}

/**
 * A local self-purchase reaches receipt handling only after the buyer leg
 * successfully posted the same AtomicBEEF. Reposting it from the seller leg
 * adds a full miner timeout to the critical path without changing custody.
 */
export function chooseMarketReceiptBroadcastPath(args: {
  localSelfPurchase: boolean
}): MarketReceiptBroadcastPath {
  return args.localSelfPurchase
    ? { broadcast: 'alreadyConfirmedByLocalBuyer' }
    : { broadcast: 'sellerPostBeef' }
}

/** Account-safe retry route for a signed purchase whose seller handoff is pending. */
export function choosePendingMarketReceiptPath(args: {
  activeIdentityKey: string
  buyerIdentityKey: string
  sellerIdentityKey: string
}): PendingMarketReceiptPath {
  const active = args.activeIdentityKey.trim().toLowerCase()
  if (args.buyerIdentityKey.trim().toLowerCase() !== active) {
    return { path: 'skip', reason: 'foreign-buyer-account' }
  }
  if (args.sellerIdentityKey.trim().toLowerCase() === active) {
    return { path: 'localSellerReconcile' }
  }
  return {
    path: 'messageboxDelivery',
    sellerIdentityKey: args.sellerIdentityKey,
  }
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
