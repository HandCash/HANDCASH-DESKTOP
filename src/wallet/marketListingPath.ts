import { isTokenScript } from './ordinalOwnership'

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
      reason:
        | 'listing-never-sent'
        | 'offer-not-held'
        | 'offer-invalid'
        | 'listing-not-active'
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

/** How a cancelled listing's item comes back: it follows its satoshi to P2PKH. */
export type MarketCancelReturn =
  | { kind: 'ordinal' }
  | { kind: 'refuse'; reason: 'no-listed-lock' | 'asset-mismatch' }

export function chooseMarketCancelReturn(args: {
  /** The listed output's locking script, read from the listing transaction. */
  listedLockHex: string | undefined
}): MarketCancelReturn {
  const hex = args.listedLockHex?.trim().toLowerCase()
  if (!hex) return { kind: 'refuse', reason: 'no-listed-lock' }
  if (isTokenScript(hex)) return { kind: 'refuse', reason: 'asset-mismatch' }
  return { kind: 'ordinal' }
}

export function chooseMarketCancelPath(args: {
  offerOutpoint: string
  /** The signed listing was refused before any miner took it: no offer exists. */
  neverSent: boolean
  held: boolean
  valid: boolean
  active: boolean
}): MarketCancelPath {
  if (args.neverSent) return { path: 'refuse', reason: 'listing-never-sent' }
  if (!args.held) return { path: 'refuse', reason: 'offer-not-held' }
  if (!args.valid) return { path: 'refuse', reason: 'offer-invalid' }
  if (!args.active) return { path: 'refuse', reason: 'listing-not-active' }
  return { path: 'spendOffer', offerOutpoint: args.offerOutpoint }
}
