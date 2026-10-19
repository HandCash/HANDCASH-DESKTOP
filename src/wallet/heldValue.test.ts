import { describe, expect, it } from 'vitest'
import { coinPaymentChain } from './appActivity'
import { coinActivityUsdLabel, coinUsd, holdingSplitLabel } from './heldValue'

const split = (...parts: Array<[string, number]>) => holdingSplitLabel(parts.map(([ticker, usd]) => ({ ticker, usd })))

describe('held value', () => {
  it('prices every native coin payment row in dollars at its own coin, signed like a BSV row, and no token row', () => {
    const row = (kind: 'spent' | 'earned', method: string, item: object) =>
      ({ id: '1', origin: 'wallet', kind, sats: 0, at: 1, method, item }) as never
    const ltc = { name: 'LTC', origin: 'ltc', amt: '137080', dec: 8, backedBy: 'ltc' }
    const doge = { name: 'DOGE', origin: 'doge', amt: '1000000000', dec: 8, backedBy: 'doge' }
    const prices = { ltc: 100, doge: 0.2 }
    expect(coinActivityUsdLabel(row('spent', 'ltc-send', ltc), prices)).toBe('−$0.14')
    expect(coinActivityUsdLabel(row('earned', 'ltc-receive', ltc), prices)).toBe('+$0.14')
    expect(coinActivityUsdLabel(row('earned', 'doge-receive', doge), prices)).toBe('+$2.00')
    expect(coinActivityUsdLabel(row('earned', 'btc-receive', { ...doge, name: 'BTC' }), prices)).toBeNull()
    expect(coinActivityUsdLabel(row('earned', 'receive-token', { ...ltc, name: 'wLTC' }), prices)).toBeNull()
  })

  it('names the chain of a coin payment row and nothing else', () => {
    expect(coinPaymentChain({ method: 'bch-send' })).toBe('bch')
    expect(coinPaymentChain({ method: 'btc-receive' })).toBe('btc')
    expect(coinPaymentChain({ method: 'receive-token' })).toBeNull()
    expect(coinPaymentChain({ method: 'wltc-credit' })).toBeNull()
  })

  it('prices smallest units at the coin quote, and admits an unknown quote', () => {
    expect(coinUsd('ltc', 100_000_000n, 80)).toBe(80)
    expect(coinUsd('ltc', 839_066n, 80)).toBeCloseTo(0.6712528)
    expect(coinUsd('btc', 1n, null)).toBeNull()
  })

  it('splits the total by value in whole percent, leaving out coins worth nothing', () => {
    expect(split(['BSV', 92], ['LTC', 8])).toBe('92% BSV + 8% LTC')
    expect(split(['BSV', 50], ['LTC', 30], ['BTC', 0], ['DOGE', 20])).toBe('50% BSV + 30% LTC + 20% DOGE')
  })

  it('never rounds a holding away or claims all of the total', () => {
    expect(split(['BSV', 1000], ['LTC', 1])).toBe('>99% BSV + <1% LTC')
    expect(split(['BSV', 1], ['BCH', 1000])).toBe('<1% BSV + >99% BCH')
  })

  it('has no split with only BSV, and is all of one coin without BSV', () => {
    expect(split(['BSV', 10], ['LTC', 0])).toBeNull()
    expect(split(['BSV', 0], ['LTC', 0])).toBeNull()
    expect(split(['BSV', 0], ['LTC', 5])).toBe('100% LTC')
  })
})
