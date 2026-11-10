import { describe, expect, it } from 'vitest'

import {
  amountToSats,
  formatUsd,
  formatUsdFromSats,
  getCachedFiatPerBsv,
  getCachedUsdPerBsv,
  mergeFiatRates,
  noteUsdPerBsv,
} from './fx'

describe('fiat rate merge', () => {
  it('keeps a CAD cross rate when a source prices USD alone', () => {
    const merged = mergeFiatRates({ usd: 16, cad: 22.4, eur: 14.4 }, { usd: 20 })
    expect(merged.usd).toBe(20)
    expect(merged.cad).toBeCloseTo(28, 10)
    expect(merged.eur).toBeCloseTo(18, 10)
  })

  it('takes every fiat a full source does price', () => {
    expect(mergeFiatRates({ usd: 16, cad: 22.4 }, { usd: 20, cad: 27 })).toEqual({ usd: 20, cad: 27 })
  })

  it('ignores a source without a USD price', () => {
    expect(mergeFiatRates({ usd: 16, cad: 22.4 }, { cad: 30 })).toEqual({ usd: 16, cad: 22.4 })
  })

  it('the ticker price becomes the rate amounts convert at', () => {
    noteUsdPerBsv(16.19)
    expect(getCachedUsdPerBsv()).toBe(16.19)
    expect(getCachedFiatPerBsv('usd')).toBe(16.19)
    expect(amountToSats('16.19', 'usd')).toBe(100_000_000)
  })
})

describe('sub-cent USD formatting', () => {
  it('never rounds a positive sub-cent amount down to zero', () => {
    expect(formatUsd(0.001)).toBe('$0.001')
    expect(formatUsd(0.00001)).toBe('$0.00001')
    expect(formatUsd(0.0000005)).toBe('$0.0000005')
  })

  it('preserves sub-cent values in compact contexts too', () => {
    expect(formatUsd(0.001, { compact: true })).toBe('$0.001')
  })

  it('shows the fiat value of a one-satoshi tip', () => {
    expect(formatUsdFromSats(1, 50)).toBe('$0.0000005')
  })

  it('keeps normal currency values at cent precision', () => {
    expect(formatUsd(12.3456)).toBe('$12.35')
    expect(formatUsd(0)).toBe('$0.00')
  })
})
