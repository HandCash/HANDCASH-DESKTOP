import type { SwapAsset } from './assets'
import type { SignedSwapOffer } from './offer'

/**
 * HandCash's cut of a direct swap, success only: 0.5% of one leg, paid by a
 * third hash-locked output on that leg (`settle.ts`). The BSV leg carries it
 * when there is one, else the maker's; the taker bears it either way.
 */

export type SwapLegId = 'taker' | 'maker'

export type SwapFee = { leg: SwapLegId; amount: string }

/** Upper bounds, in smallest units of each chain, of one claim transaction on a direct swap. */
export const DIRECT_CLAIM_COST: Record<SwapAsset, bigint> = { bsv: 100n, ltc: 1_000n, bch: 500n, btc: 5_000n, doge: 200_000n }

/** HandCash's swap fee key: claims fee outputs once their swap has happened (BRC-CLOUD `swapFees.js`). */
export const HANDCASH_SWAP_FEE_PUB = '03a7844691b951beb4261441a53e5248fba582babb72ce189e8b21e8dfe8442487'

/** HandCash's cut of a direct swap, in basis points of the fee leg. */
export const SWAP_FEE_BPS = 50n
/** No fee output smaller than this many of its own claim transactions. */
const FEE_FLOOR_CLAIMS = 10n

/** Which leg pays HandCash's cut: the BSV one when there is one, else the maker's. */
export function feeLegOf(offer: Pick<SignedSwapOffer, 'give' | 'get'>): SwapLegId {
  return offer.get === 'bsv' ? 'taker' : 'maker'
}

/** The cut on a swap of `pay` for `receive`: 0.5% of the fee leg, or none below the floor. */
export function swapFee(offer: Pick<SignedSwapOffer, 'give' | 'get'>, pay: bigint, receive: bigint): SwapFee | null {
  const leg = feeLegOf(offer)
  const chain = leg === 'taker' ? offer.get : offer.give
  const amount = ((leg === 'taker' ? pay : receive) * SWAP_FEE_BPS) / 10_000n
  if (amount < DIRECT_CLAIM_COST[chain] * FEE_FLOOR_CLAIMS) return null
  return { leg, amount: amount.toString() }
}

/** What the taker pays and receives once the fee is in. */
export function takerTotals(terms: { pay: string; receive: string; fee: SwapFee | null }): { pays: bigint; receives: bigint; fee: bigint } {
  const fee = terms.fee ? BigInt(terms.fee.amount) : 0n
  const onTaker = terms.fee?.leg === 'taker'
  return { pays: BigInt(terms.pay) + (onTaker ? fee : 0n), receives: BigInt(terms.receive) - (onTaker ? 0n : fee), fee }
}

/**
 * The amount to put into `offer` so that, with a fee on the taker's leg, the
 * wallet spends no more than `budget` in all. With the fee on the maker's leg
 * (or none) that is `budget` itself.
 */
export function lockWithin(offer: Pick<SignedSwapOffer, 'give' | 'get'>, budget: bigint, receiveOf: (pay: bigint) => bigint | null): bigint {
  if (feeLegOf(offer) !== 'taker') return budget
  const whole = receiveOf(budget)
  if (whole === null || !swapFee(offer, budget, whole)) return budget
  return (budget * 10_000n) / (10_000n + SWAP_FEE_BPS)
}
