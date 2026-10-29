import { describe, expect, it } from 'vitest'
import { TICKER_COINS, TICKER_COIN_ORDER } from './tickerCoin'

describe('ticker coin copy', () => {
  it('names BSV Bitcoin SV, never bare Bitcoin', () => {
    expect(TICKER_COINS.bsv.name).toBe('Bitcoin SV')
    expect(TICKER_COINS.bsv.about).toMatch(/^Bitcoin SV /)
    expect(TICKER_COINS.bsv.about).not.toMatch(/Bitcoin(?! SV)/)
  })

  it('never puts a ticker in brackets after a coin name', () => {
    for (const coin of TICKER_COIN_ORDER) {
      const { name, sym, about } = TICKER_COINS[coin]
      expect(name).not.toContain(`(${sym})`)
      expect(about).not.toMatch(/\([A-Z]{3,5}\)/)
    }
  })

  it('names Circle’s token USDC, not Arc USD', () => {
    expect(TICKER_COINS['arc-usd'].name).toBe('USDC')
    expect(TICKER_COINS['arc-usd'].sym).toBe('USDC')
    expect(TICKER_COINS['arc-usd'].aboutTitle).toBe('What is USDC?')
    expect(TICKER_COINS['arc-usd'].about).toMatch(/USDC/)
    expect(TICKER_COINS['arc-usd'].about).not.toMatch(/Arc USD/)
  })
})
