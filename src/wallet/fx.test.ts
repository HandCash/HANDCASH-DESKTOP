import { describe, expect, it } from 'vitest'

import { formatUsd, formatUsdFromSats } from './fx'

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
