import { describe, expect, it } from 'vitest'
import { summarizeAction } from './permissions'

describe('HCT permission summary', () => {
  it('states the supply policy an issue fixes for good', () => {
    const issue = (extra: Record<string, unknown>) =>
      summarizeAction('issueHctAsset', { kind: 'token', sym: 'GOLD', supply: '1000', ...extra }).details
    expect(issue({})).toContain('Fixed supply: nothing more can ever be minted')
    expect(issue({ auth: true })).toContain('Open supply: you can mint more, with no cap')
    expect(issue({ max: '5000' })).toContain('Capped supply: you can mint more, at most 5000 units')
    expect(issue({ size: '10' })).toContain('Capped supply: you can mint more, at most 10 items')
  })

  it('names the asset a mint creates units of', () => {
    const summary = summarizeAction('mintHctAsset', { assetId: 'ab'.repeat(20), amount: '25' })
    expect(summary.title).toBe('Mint 25')
    expect(summary.tokenId).toBe('ab'.repeat(20))
  })

  it('names the LTC amount and destination of a withdrawal', () => {
    const summary = summarizeAction('withdrawLtc', { address: 'ltc1qexample', litoshi: '12500000' })
    expect(summary.title).toBe('Withdraw 0.125 LTC')
    expect(summary.details).toContain('To: ltc1qexample')
  })
})
