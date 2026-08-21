export type MarketListingPath =
  | { path: 'createOffer'; itemOutpoint: string }
  | {
      path: 'refuse'
      reason: 'not-one-sat' | 'not-ordinal' | 'unproven-origin' | 'invalid-terms'
    }

export type MarketCancelPath =
  | { path: 'spendOffer'; offerOutpoint: string }
  | {
      path: 'refuse'
      reason: 'offer-not-held' | 'offer-invalid' | 'listing-not-active'
    }

export function chooseMarketListingPath(args: {
  itemOutpoint: string
  satoshis: number
  ordinal: boolean
  provenanceProven: boolean
  termsValid: boolean
}): MarketListingPath {
  if (args.satoshis !== 1) return { path: 'refuse', reason: 'not-one-sat' }
  if (!args.ordinal) return { path: 'refuse', reason: 'not-ordinal' }
  if (!args.provenanceProven) return { path: 'refuse', reason: 'unproven-origin' }
  if (!args.termsValid) return { path: 'refuse', reason: 'invalid-terms' }
  return { path: 'createOffer', itemOutpoint: args.itemOutpoint }
}

export function chooseMarketCancelPath(args: {
  offerOutpoint: string
  held: boolean
  valid: boolean
  active: boolean
}): MarketCancelPath {
  if (!args.held) return { path: 'refuse', reason: 'offer-not-held' }
  if (!args.valid) return { path: 'refuse', reason: 'offer-invalid' }
  if (!args.active) return { path: 'refuse', reason: 'listing-not-active' }
  return { path: 'spendOffer', offerOutpoint: args.offerOutpoint }
}
