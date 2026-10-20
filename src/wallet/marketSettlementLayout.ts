/**
 * Where every input and output of a market settlement sits. The list-time
 * signer, the buyer, the seller's receipt check and the overlay read this one
 * table.
 *
 * Both seller inputs are signed SIGHASH_SINGLE|ANYONECANPAY, which commits to
 * the output at the signer's own index: the listed item to the seller payment,
 * the offer token to the market fee. The item cannot move without paying the
 * seller, and withdrawing the advert costs the fee.
 *
 * An ordinal follows its satoshi: two buyer pads come first and output 0
 * returns exactly their satoshis, so the item's satoshi lands in output 1
 * while the item's signature binds output 2.
 */
import type { MarketAssetType } from './marketListing'
import { unlockSighashByte } from './offerSeal'
import { SELLER_SIGHASH, SELLER_SIGHASH_BYTE } from './offerTerms'

export type MarketSettlementLayout = 'ordinal-v2'

export type MarketSettlementShape = {
  layout: MarketSettlementLayout
  /** Buyer-owned root P2PKH inputs ahead of the item. */
  padVins: readonly number[]
  itemVin: number
  offerVin: number
  /** Pad satoshis back to the buyer, exactly. */
  padReturnOutputIndex: number | null
  buyerOutputIndex: number
  sellerOutputIndex: number
  feeOutputIndex: number
  /** First output the buyer may use for change. */
  firstChangeIndex: number
}

export const MARKET_SETTLEMENT_VERSION = 2 as const

/** Basket for the buyer's ordinal pads. Not `default`, so funding never spends them. */
export const MARKET_PAD_BASKET = 'market-pads'
export const MARKET_PAD_COUNT = 2

const ORDINAL: MarketSettlementShape = {
  layout: 'ordinal-v2',
  padVins: [0, 1],
  itemVin: 2,
  offerVin: 3,
  padReturnOutputIndex: 0,
  buyerOutputIndex: 1,
  sellerOutputIndex: 2,
  feeOutputIndex: 3,
  firstChangeIndex: 4,
}

export function marketSettlementShape(_assetType: MarketAssetType): MarketSettlementShape {
  return ORDINAL
}

/** True when (seller, fee) are the payment outputs of the v2 layout. */
export function isMarketPayoutIndexPair(sellerOutputIndex: number, feeOutputIndex: number): boolean {
  return ORDINAL.sellerOutputIndex === sellerOutputIndex && ORDINAL.feeOutputIndex === feeOutputIndex
}

export type MarketSettlementUnlocksV2 = {
  version: typeof MARKET_SETTLEMENT_VERSION
  layout: MarketSettlementLayout
  itemUnlockingScript: string
  offerUnlockingScript: string
  itemSighash: typeof SELLER_SIGHASH
  offerSighash: typeof SELLER_SIGHASH
  sellerSats: number
  feeSats: number
}

/**
 * True when list-time unlocks are the bound v2 form for this asset. Version 1
 * signed the item NONE|ANYONECANPAY, which let anyone holding the advert take
 * the item.
 */
export function unlocksBindSellerPayment(
  unlocks: unknown,
  assetType: MarketAssetType,
): unlocks is MarketSettlementUnlocksV2 {
  if (!unlocks || typeof unlocks !== 'object') return false
  const u = unlocks as Partial<MarketSettlementUnlocksV2>
  return (
    u.version === MARKET_SETTLEMENT_VERSION &&
    u.layout === marketSettlementShape(assetType).layout &&
    typeof u.itemUnlockingScript === 'string' &&
    typeof u.offerUnlockingScript === 'string' &&
    unlockSighashByte(u.itemUnlockingScript) === SELLER_SIGHASH_BYTE &&
    unlockSighashByte(u.offerUnlockingScript) === SELLER_SIGHASH_BYTE
  )
}
