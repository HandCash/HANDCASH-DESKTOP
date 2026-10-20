import { describe, expect, it, vi } from 'vitest'

const prices = vi.hoisted(() => ({ ltc: 80 as number | null, bch: 400 as number | null, bsv: 40 as number | null }))
vi.mock('./bsvMarket', async (orig) => ({
  ...(await orig<typeof import('./bsvMarket')>()),
  getCachedBsvMarket: (coin?: string) => {
    const price = coin === 'ltc' ? prices.ltc : coin === 'bch' ? prices.bch : null
    return price ? { priceUsd: price } : null
  },
}))
vi.mock('./fx', async (orig) => ({
  ...(await orig<typeof import('./fx')>()),
  getCachedUsdPerBsv: () => prices.bsv,
}))

import { summarizeAction } from './permissions'

describe('BNT permission summary', () => {
  it('states the supply policy an issue fixes for good', () => {
    const issue = (extra: Record<string, unknown>) =>
      summarizeAction('issueBntAsset', { kind: 'token', sym: 'GOLD', supply: '1000', ...extra }).details
    expect(issue({})).toContain('Fixed supply: nothing more can ever be minted')
    expect(issue({ auth: true })).toContain('Open supply: you can mint more, with no cap')
    expect(issue({ max: '5000' })).toContain('Capped supply: you can mint more, at most 5000 units')
    expect(issue({ size: '10' })).toContain('Capped supply: you can mint more, at most 10 items')
  })

  it('names the asset a mint creates units of', () => {
    const summary = summarizeAction('mintBntAsset', { assetId: 'ab'.repeat(20), amount: '25' })
    expect(summary.title).toBe('Mint 25 units')
    expect(summary.tokenId).toBe('ab'.repeat(20))
  })

  it('asks for an LTC payment as it asks for a BSV one, the amount in LTC', () => {
    const summary = summarizeAction('sendCoins', {
      chain: 'ltc',
      address: 'ltc1qexample',
      amount: '12500000',
      description: 'Arcade credits',
    })
    expect(summary.title).toBe('Approve Litecoin payment')
    expect(summary.summary).toBe('Arcade credits')
    expect(summary.amountLabel).toBe('0.125 LTC')
    expect(summary.amountNote).toBe('$10.00')
    // Never rendered as BSV: the prompt formats amountSats as BSV.
    expect(summary.amountSats).toBeUndefined()
    // $10 at $40/BSV counts 0.25 BSV against the app's budget.
    expect(summary.budgetSats).toBe(25_000_000)
    expect(summary.details).toContain('To: ltc1qexample')
  })

  it('leaves an LTC payment uncounted without both prices, so it is never auto-paid', () => {
    prices.bsv = null
    const summary = summarizeAction('sendCoins', { chain: 'ltc', address: 'ltc1qexample', amount: '12500000' })
    prices.bsv = 40
    expect(summary.summary).toBe('Payment from a connected app')
    expect(summary.budgetSats).toBeUndefined()
  })

  it('asks for a BCH payment the same way, at its own price', () => {
    const summary = summarizeAction('sendCoins', { chain: 'bch', address: 'bitcoincash:qexample', amount: '2500000' })
    expect(summary.title).toBe('Approve Bitcoin Cash payment')
    expect(summary.amountLabel).toBe('0.025 BCH')
    expect(summary.amountNote).toBe('$10.00')
    expect(summary.budgetSats).toBe(25_000_000)
    expect(summary.details).toContain('Paid on Bitcoin Cash from this wallet; the Bitcoin Cash network fee is added on top')
  })
})
