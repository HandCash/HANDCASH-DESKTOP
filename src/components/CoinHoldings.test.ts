import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { MarketCoin } from '../wallet/bsvMarket'
import { coinHoldings, holdingsColumns, holdingsRows, showsHoldings } from '../wallet/coinHoldings'
import { CoinHoldings } from './CoinHoldings'

const ALL: Array<{ coin: MarketCoin; amount: string; usd: number }> = [
  { coin: 'doge', amount: '1200 DOGE', usd: 100 },
  { coin: 'bsv', amount: '2 BSV', usd: 400 },
  { coin: 'btc', amount: '0.003 BTC', usd: 300 },
  { coin: 'ltc', amount: '1.5 LTC', usd: 150 },
  { coin: 'bch', amount: '0.1 BCH', usd: 50 },
]

const held = (n: number) => coinHoldings(ALL.slice(0, n).map((h) => ({ ...h, nonZero: true })))

describe('coin holdings layout', () => {
  it('balances rows for one to five coins at full width', () => {
    expect([1, 2, 3, 4, 5].map((n) => holdingsRows(n))).toEqual([[1], [2], [3], [2, 2], [3, 2]])
  })

  it('drops to two a row, then one, on narrow heroes', () => {
    expect([1, 2, 3, 4, 5].map((n) => holdingsRows(n, Math.min(2, holdingsColumns(n))))).toEqual([[1], [2], [2, 1], [2, 2], [2, 2, 1]])
    expect(holdingsRows(5, 1)).toEqual([1, 1, 1, 1, 1])
  })

  it('shows the strip only from two coins; one coin is the headline alone', () => {
    expect(showsHoldings(held(1))).toBe(false)
    expect(showsHoldings(held(2))).toBe(true)
  })

  it('lists held coins in ticker order with their share of the total', () => {
    const five = held(5)
    expect(five.map((h) => h.coin)).toEqual(['bsv', 'ltc', 'bch', 'btc', 'doge'])
    expect(five.map((h) => h.pct)).toEqual(['40%', '15%', '5%', '30%', '10%'])
    expect(five.reduce((sum, h) => sum + (h.share ?? 0), 0)).toBeCloseTo(1)
    expect(five[0]!.name).toBe('Bitcoin SV')
  })

  it('leaves out coins held at zero and has no shares until every coin is priced', () => {
    const list = coinHoldings([
      { coin: 'bsv', amount: '0 BSV', usd: 0, nonZero: false },
      { coin: 'ltc', amount: '1 LTC', usd: null, nonZero: true },
      { coin: 'btc', amount: '0.1 BTC', usd: 6000, nonZero: true },
    ])
    expect(list.map((h) => h.coin)).toEqual(['ltc', 'btc'])
    expect(list.every((h) => h.share === null && h.pct === null)).toBe(true)
  })

  for (const n of [2, 3, 4, 5]) {
    it(`renders ${n} coins: one chip each, an accent per coin, the ticker once`, () => {
      const html = renderToStaticMarkup(createElement(CoinHoldings, { holdings: held(n) }))
      expect(html).toContain(`data-count="${n}"`)
      expect(html).toContain(`data-cols="${holdingsColumns(n)}"`)
      expect(html.match(/class="coin-holding"/g)).toHaveLength(n)
      expect(html.match(/<span data-coin="[a-z]+" style="flex-grow:/g)).toHaveLength(n)
      expect(html).not.toMatch(/\(BSV\)|\(LTC\)/)
    })
  }

  it('drops the share bar while a coin has no price', () => {
    const list = coinHoldings([
      { coin: 'bsv', amount: '2 BSV', usd: 400, nonZero: true },
      { coin: 'ltc', amount: '1 LTC', usd: null, nonZero: true },
    ])
    const html = renderToStaticMarkup(createElement(CoinHoldings, { holdings: list }))
    expect(html).not.toContain('coin-holdings-bar')
    expect(html).toContain('1 LTC')
  })
})
