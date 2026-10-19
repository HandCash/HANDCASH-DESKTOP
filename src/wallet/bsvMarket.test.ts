import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getCachedBsvMarket, refreshMarketBoard, statsFromBoardRow, type BsvMarketStats } from './bsvMarket'

const week = Array.from({ length: 168 }, (_, i) => 10 + i / 10)

const row = (id: string, price: number) => ({
  id,
  current_price: price,
  circulating_supply: 1_000,
  price_change_percentage_24h_in_currency: 1.5,
  price_change_percentage_7d_in_currency: -2,
  price_change_percentage_30d_in_currency: 8,
  sparkline_in_7d: { price: week },
})

describe('statsFromBoardRow', () => {
  it('prices a coin from one markets row, the last day of the week series as 24h', () => {
    const s = statsFromBoardRow('doge', row('dogecoin', 0.08), null, 1)!
    expect(s.priceUsd).toBe(0.08)
    expect([s.change24hPct, s.change7dPct, s.change30dPct]).toEqual([1.5, -2, 8])
    expect(s.sparklines['24h']).toEqual(week.slice(-24))
    expect(s.sparklines['7d'].length).toBeGreaterThan(24)
    expect(s.minedSupply).toBe(1_000)
  })

  it('keeps the cached 30-day series, which the row does not carry', () => {
    const cached = { sparklines: { '24h': [], '7d': [], '30d': [1, 2, 3] }, change30dPct: 4 } as unknown as BsvMarketStats
    const s = statsFromBoardRow('ltc', { ...row('litecoin', 60), price_change_percentage_30d_in_currency: null }, cached, 1)!
    expect(s.sparklines['30d']).toEqual([1, 2, 3])
    expect(s.change30dPct).toBe(4)
  })

  it('refuses a row with no price', () => {
    expect(statsFromBoardRow('btc', { id: 'bitcoin' }, null, 1)).toBeNull()
  })
})

describe('refreshMarketBoard', () => {
  beforeEach(() => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('prices every ticker coin with a single request', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify([
          row('bitcoin-cash-sv', 17.79),
          row('litecoin', 59.37),
          row('bitcoin-cash', 277.33),
          row('bitcoin', 82_447),
          row('dogecoin', 0.0798),
        ]),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    await Promise.all([refreshMarketBoard(true), refreshMarketBoard(true)])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(getCachedBsvMarket('doge')?.priceUsd).toBe(0.0798)
    expect(getCachedBsvMarket('bch')?.priceUsd).toBe(277.33)
    expect(getCachedBsvMarket('bsv')?.priceUsd).toBe(17.79)
  })
})
