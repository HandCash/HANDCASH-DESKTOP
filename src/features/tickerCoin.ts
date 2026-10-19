import { useSyncExternalStore } from 'react'
import type { MarketCoin } from '../wallet/bsvMarket'
import { getTickerCoin, subscribeTickerCoin } from '../wallet/tickerCoin'

/** The coin the ticker shows, shared by the ticker and its selector wherever each is mounted. */
export function useTickerCoin(): MarketCoin {
  return useSyncExternalStore(subscribeTickerCoin, getTickerCoin, getTickerCoin)
}
