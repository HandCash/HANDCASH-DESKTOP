import { OFFICIAL_URL, type MarketCoin } from './bsvMarket'
import { COIN_CHAINS, COIN_INFO, type CoinChain } from './coins/coinChains'

type TickerCoinInfo = { name: string; sym: string; about: string; aboutTitle: string; url: string }

/** What the ticker says about each coin it can show. */
export const TICKER_COINS: Record<MarketCoin, TickerCoinInfo> = {
  bsv: {
    name: 'Bitcoin SV',
    sym: 'BSV',
    aboutTitle: 'What is BSV?',
    about:
      'Bitcoin SV is an electronic cash system that enables direct, online payments from one party to another. It functions exactly like physical cash but for the web.',
    url: OFFICIAL_URL,
  },
  ...(Object.fromEntries(
    COIN_CHAINS.map((chain) => {
      const { label, ticker, confirmations, url } = COIN_INFO[chain]
      return [
        chain,
        {
          name: label,
          sym: ticker,
          aboutTitle: `What is ${ticker}?`,
          about: `${label} is a separate blockchain. This wallet holds ${ticker} with its own key, on ${label} itself, and counts ${confirmations} ${label} confirmations before a received coin can be spent.`,
          url,
        },
      ]
    }),
  ) as Record<CoinChain, TickerCoinInfo>),
}

export const TICKER_COIN_ORDER: readonly MarketCoin[] = ['bsv', ...COIN_CHAINS]

let coin: MarketCoin = 'bsv'
const listeners = new Set<() => void>()

export function getTickerCoin(): MarketCoin {
  return coin
}

export function setTickerCoin(next: MarketCoin): void {
  if (next === coin) return
  coin = next
  for (const listener of listeners) listener()
}

export function subscribeTickerCoin(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
