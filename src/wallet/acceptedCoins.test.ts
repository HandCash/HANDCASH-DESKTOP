import { beforeEach, describe, expect, it, vi } from 'vitest'
import { storageRegistry } from '../storage/registry'
import { COIN_CHAINS } from './coins/coinChains'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (k: string) => store.get(k) ?? null,
  durableSetItem: (k: string, v: string) => {
    store.set(k, v)
    return true
  },
  durableRemoveItem: (k: string) => {
    store.delete(k)
  },
}))

const KEY = storageRegistry.acceptedCoins.key

describe('accepted coins', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
  })

  it('keeps showing every coin for a wallet made before the choice existed', async () => {
    const { getAcceptedCoins, shownCoinChains } = await import('./acceptedCoins')
    expect(getAcceptedCoins()).toBe('all')
    expect(shownCoinChains()).toEqual(COIN_CHAINS)
  })

  it('starts new wallets on Just Bitcoin SV', async () => {
    const { DEFAULT_ACCEPTED_COINS, acceptedCoinsChoice } = await import('./acceptedCoins')
    expect(DEFAULT_ACCEPTED_COINS).toBe('bitcoin')
    expect(acceptedCoinsChoice(DEFAULT_ACCEPTED_COINS).title).toBe('Just Bitcoin SV')
  })

  it('stores the choice and tells subscribers', async () => {
    const { getAcceptedCoins, setAcceptedCoins, subscribeAcceptedCoins } = await import('./acceptedCoins')
    const heard = vi.fn()
    const stop = subscribeAcceptedCoins(heard)
    setAcceptedCoins('bitcoin')
    expect(store.get(KEY)).toBe('bitcoin')
    expect(getAcceptedCoins()).toBe('bitcoin')
    expect(heard).toHaveBeenCalledTimes(1)
    stop()
    setAcceptedCoins('all')
    expect(heard).toHaveBeenCalledTimes(1)
    expect(getAcceptedCoins()).toBe('all')
  })

  it('ignores a stored value it does not know', async () => {
    store.set(KEY, 'everything')
    const { getAcceptedCoins } = await import('./acceptedCoins')
    expect(getAcceptedCoins()).toBe('all')
  })

  it('hides other coins and the tokens they back on Just Bitcoin SV, never Bitcoin SV itself', async () => {
    const { isChainShown, shownCoinChains } = await import('./acceptedCoins')
    expect(shownCoinChains('bitcoin')).toEqual([])
    expect(shownCoinChains('all')).toEqual(COIN_CHAINS)
    for (const chain of COIN_CHAINS) {
      expect(isChainShown(chain, 'bitcoin')).toBe(false)
      expect(isChainShown(chain, 'all')).toBe(true)
    }
    expect(isChainShown('bsv', 'bitcoin')).toBe(true)
    expect(isChainShown(null, 'bitcoin')).toBe(true)
    expect(isChainShown(undefined, 'bitcoin')).toBe(true)
  })

  it('moves the ticker back to Bitcoin SV when other coins are hidden', async () => {
    const { setAcceptedCoins } = await import('./acceptedCoins')
    const { getTickerCoin, setTickerCoin } = await import('./tickerCoin')
    setTickerCoin('ltc')
    setAcceptedCoins('all')
    expect(getTickerCoin()).toBe('ltc')
    setAcceptedCoins('bitcoin')
    expect(getTickerCoin()).toBe('bsv')
  })

  it('never calls Bitcoin SV a crypto', async () => {
    const { ACCEPTED_COINS_CHOICES } = await import('./acceptedCoins')
    expect(ACCEPTED_COINS_CHOICES.map((choice) => choice.title)).toEqual(['Just Bitcoin SV', 'Bitcoin SV and crypto'])
    const copy = ACCEPTED_COINS_CHOICES.flatMap((choice) => [choice.title, choice.description]).join(' ')
    expect(copy).not.toMatch(/other crypto|all crypto|crypto including/i)
    expect(copy).not.toMatch(/\(BSV\)|\(LTC\)|\(BTC\)/)
  })
})
