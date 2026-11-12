import { beforeEach, describe, expect, it, vi } from 'vitest'

let usdPerBsv: number | null = 50
let usdPerCoin: number | null = 100

vi.mock('../fx', () => ({ getCachedUsdPerBsv: () => usdPerBsv }))
vi.mock('../bsvMarket', () => ({ getCachedBsvMarket: () => (usdPerCoin ? { priceUsd: usdPerCoin } : null) }))

const { coinBudgetSats, usdcBudgetSats } = await import('./budget')

describe('one budget in satoshis of equal dollar value', () => {
  beforeEach(() => {
    usdPerBsv = 50
    usdPerCoin = 100
  })

  it('counts USDC at $1 per 1,000,000 atoms', () => {
    // $5 at $50/BSV is 0.1 BSV.
    expect(usdcBudgetSats(5_000_000n)).toBe(10_000_000)
    expect(usdcBudgetSats(1n)).toBe(2)
  })

  it('counts a coin at its price against BSV', () => {
    // 0.05 coin at $100 is $5, so 0.1 BSV.
    expect(coinBudgetSats('ltc', 5_000_000n)).toBe(10_000_000)
  })

  it('has no count without a price, so the payment is prompted', () => {
    usdPerBsv = null
    expect(usdcBudgetSats(5_000_000n)).toBeNull()
    expect(coinBudgetSats('ltc', 5_000_000n)).toBeNull()
  })
})
