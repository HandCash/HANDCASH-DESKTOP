import type { Bsv21BinaryLayout } from './token/decode162'

/**
 * One offer mechanism, two venues.
 *
 * A seller holds an exact lot out of its balance and signs that input
 * SIGHASH_SINGLE|ANYONECANPAY, binding the output at the same index to what it
 * wants back. Anyone can then complete the trade without the seller, and only
 * by paying that output exactly.
 *
 * `market` publishes the offer as a BRC-48 advert on the overlay; the buyer
 * also pays the market fee, which the advert deposit signs over. `direct`
 * hands the same offer to a buyer as JSON: no index, no fee, and the price may
 * be sats or another token.
 */
export type OfferVenue = 'market' | 'direct'

export type OfferWant =
  | { kind: 'sats'; sats: number }
  | {
      kind: 'token'
      tokenId: string
      amount: string
      layout: Bsv21BinaryLayout
      sym?: string
      dec?: number
    }

export type OfferOperation = 'list' | 'buy' | 'collect' | 'cancel'

export const SELLER_SIGHASH = 'SINGLE|ANYONECANPAY' as const
/** FORKID (0x40) | ANYONECANPAY (0x80) | SINGLE (3). */
export const SELLER_SIGHASH_BYTE = 0xc3
