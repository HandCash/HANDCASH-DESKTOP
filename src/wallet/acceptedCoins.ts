import { storageRegistry } from '../storage/registry'
import { durableGetItem, durableSetItem } from './durableStorage'
import { COIN_CHAINS, COIN_INFO, type CoinChain } from './coins/coinChains'
import { getTickerCoin, setTickerCoin } from './tickerCoin'

/**
 * What this wallet accepts: Bitcoin SV alone, or Bitcoin SV and the other
 * coins it holds natively. Bitcoin SV is never one of the crypto.
 */
export type AcceptedCoins = 'bitcoin' | 'all'

/** What a new wallet starts on, and what onboarding preselects. */
export const DEFAULT_ACCEPTED_COINS: AcceptedCoins = 'bitcoin'

const KEY = storageRegistry.acceptedCoins.key
const NO_CHAINS: readonly CoinChain[] = Object.freeze([])
const listeners = new Set<() => void>()

const otherTickers = COIN_CHAINS.map((chain) => COIN_INFO[chain].ticker).join(', ')

export const ACCEPTED_COINS_CHOICES: readonly { id: AcceptedCoins; title: string; description: string }[] = [
  {
    id: 'bitcoin',
    title: 'Just Bitcoin SV',
    description: 'Bitcoin SV and its tokens. Other coins and tokens backed by them are hidden, not removed.',
  },
  {
    id: 'all',
    title: 'Bitcoin SV and crypto',
    description: `Bitcoin SV and its tokens, plus ${otherTickers}, Arc USD, and tokens backed by them.`,
  },
]

export function acceptedCoinsChoice(accepted: AcceptedCoins) {
  return ACCEPTED_COINS_CHOICES.find((choice) => choice.id === accepted) ?? ACCEPTED_COINS_CHOICES[0]!
}

/** Unset means a wallet made before the choice existed: it keeps showing the coins it already showed. */
export function getAcceptedCoins(): AcceptedCoins {
  const raw = durableGetItem(KEY)
  return raw === 'bitcoin' || raw === 'all' ? raw : 'all'
}

export function setAcceptedCoins(next: AcceptedCoins): void {
  durableSetItem(KEY, next)
  if (next === 'bitcoin' && getTickerCoin() !== 'bsv') setTickerCoin('bsv')
  for (const listener of listeners) listener()
}

export function subscribeAcceptedCoins(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The other coins the wallet shows: none for "Just Bitcoin SV". */
export function shownCoinChains(accepted: AcceptedCoins = getAcceptedCoins()): readonly CoinChain[] {
  return accepted === 'all' ? COIN_CHAINS : NO_CHAINS
}

/** Whether a coin, a token backed by `chain` or a row that moved it shows; Bitcoin SV (no chain) always does. */
export function isChainShown(chain: string | null | undefined, accepted: AcceptedCoins = getAcceptedCoins()): boolean {
  return !chain || chain === 'bsv' || accepted === 'all'
}
