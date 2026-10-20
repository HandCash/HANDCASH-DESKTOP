import { describe, expect, it } from 'vitest'
import { bntAmountLabel, rememberBntAsset } from './assetLabel'

describe('bntAmountLabel', () => {
  it('names a known asset in whole units with its symbol', () => {
    rememberBntAsset('AA'.repeat(20), { sym: 'wLTC', dec: 8 })
    expect(bntAmountLabel('aa'.repeat(20), '100000')).toBe('0.001 wLTC')
  })

  it('marks an unread asset as raw units, never a bare number', () => {
    expect(bntAmountLabel('bb'.repeat(20), '100000')).toBe('100000 units')
  })
})
