import { useSyncExternalStore } from 'react'
import { STABLE_MARKET_COINS, type MarketCoin } from '../wallet/bsvMarket'
import type { CoinChain } from '../wallet/coins/coinChains'
import { getAcceptedCoins, shownCoinChains, subscribeAcceptedCoins, type AcceptedCoins } from '../wallet/acceptedCoins'

/** "Just Bitcoin SV" or "Bitcoin SV and crypto", as chosen at setup or in Settings. */
export function useAcceptedCoins(): AcceptedCoins {
  return useSyncExternalStore(subscribeAcceptedCoins, getAcceptedCoins, getAcceptedCoins)
}

/** The other coins the wallet shows now. */
export function useShownCoinChains(): readonly CoinChain[] {
  return shownCoinChains(useAcceptedCoins())
}

const BSV_ONLY: readonly MarketCoin[] = Object.freeze(['bsv'])
const ALL_COINS = new Map<readonly CoinChain[], readonly MarketCoin[]>()

/** Bitcoin SV, then each shown coin + Arc USD when crypto is accepted. */
export function useShownMarketCoins(): readonly MarketCoin[] {
  const chains = useShownCoinChains()
  if (chains.length === 0) return BSV_ONLY
  let coins = ALL_COINS.get(chains)
  if (!coins) {
    coins = Object.freeze(['bsv', ...chains, ...STABLE_MARKET_COINS] as MarketCoin[])
    ALL_COINS.set(chains, coins)
  }
  return coins
}
