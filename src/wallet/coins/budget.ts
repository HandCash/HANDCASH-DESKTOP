import { getCachedBsvMarket } from '../bsvMarket'
import { getCachedUsdPerBsv } from '../fx'
import type { CoinChain } from './coinChains'

/**
 * What a payment of `units` on `chain` counts against an app's spending
 * budget, in satoshis of the same dollar value: Auto-pay and spending grants
 * are one budget per app, whichever coin it pays in. Null without both
 * prices, so the payment is prompted rather than guessed.
 */
export function coinBudgetSats(chain: CoinChain, units: bigint): number | null {
  const usdPerCoin = getCachedBsvMarket(chain)?.priceUsd
  const usdPerBsv = getCachedUsdPerBsv()
  if (!usdPerCoin || !usdPerBsv || !(usdPerCoin > 0) || !(usdPerBsv > 0)) return null
  const sats = Math.ceil((Number(units) * usdPerCoin) / usdPerBsv)
  return Number.isSafeInteger(sats) && sats > 0 ? sats : null
}

/** USD value of `units` on `chain` at the last known price; null without one. */
export function coinUsdValue(chain: CoinChain, units: bigint): number | null {
  const usdPerCoin = getCachedBsvMarket(chain)?.priceUsd
  return usdPerCoin && usdPerCoin > 0 ? (Number(units) / 1e8) * usdPerCoin : null
}
