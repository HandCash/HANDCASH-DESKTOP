import { useSyncExternalStore } from 'react'
import { subscribeAppActivity } from './activity'
import { getCachedBsvMarket, refreshMarketBoard, subscribeBsvMarket } from '../wallet/bsvMarket'
import { COIN_CHAINS, type CoinChain } from '../wallet/coins/coinChains'
import { COIN_WALLETS as WALLETS } from './coinWallets'

/** Smallest units of `chain` the open account can spend now. The record is durable, so the first paint already has it. */
export function getHeldCoin(chain: CoinChain): bigint {
  return BigInt(WALLETS[chain].readBalance().spendable)
}

/**
 * Told when any coin record changes, and on every account switch (which
 * writes activity). Held coins are priced once, in one request.
 */
export function subscribeHeldCoins(listener: () => void): () => void {
  const stops = COIN_CHAINS.map((chain) => {
    WALLETS[chain].ensureMigrated()
    return WALLETS[chain].subscribe(listener)
  })
  if (COIN_CHAINS.some((chain) => getHeldCoin(chain) > 0n)) void refreshMarketBoard()
  stops.push(subscribeAppActivity(listener))
  return () => {
    for (const stop of stops) stop()
  }
}

let heldCache: { key: string; held: Record<CoinChain, bigint> } | null = null
function getHeldAll(): Record<CoinChain, bigint> {
  const held = Object.fromEntries(COIN_CHAINS.map((chain) => [chain, getHeldCoin(chain)])) as Record<CoinChain, bigint>
  const key = COIN_CHAINS.map((chain) => held[chain].toString()).join(',')
  if (heldCache?.key !== key) heldCache = { key, held }
  return heldCache.held
}

/** What the open account can spend now on every chain, in smallest units. */
export function useHeldCoins(): Record<CoinChain, bigint> {
  return useSyncExternalStore(subscribeHeldCoins, getHeldAll, getHeldAll)
}

/** What the open account can spend now on `chain`, in smallest units. */
export function useHeldCoin(chain: CoinChain): bigint {
  return useHeldCoins()[chain]
}

let priceCache: { key: string; prices: Record<CoinChain, number | null> } | null = null
function getPrices(): Record<CoinChain, number | null> {
  const prices = Object.fromEntries(COIN_CHAINS.map((chain) => [chain, getCachedBsvMarket(chain)?.priceUsd ?? null])) as Record<CoinChain, number | null>
  const key = COIN_CHAINS.map((chain) => String(prices[chain])).join(',')
  if (priceCache?.key !== key) priceCache = { key, prices }
  return priceCache.prices
}

/** Last known USD price of one coin on every chain; null until its quote has loaded. */
export function useCoinPrices(): Record<CoinChain, number | null> {
  return useSyncExternalStore(subscribeBsvMarket, getPrices, getPrices)
}

/** Last known USD price of one coin on `chain`; null until a quote has loaded. */
export function useCoinPriceUsd(chain: CoinChain): number | null {
  return useCoinPrices()[chain]
}
