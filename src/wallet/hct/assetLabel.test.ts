import { describe, expect, it } from 'vitest'
import { hctAmountLabel, rememberHctAsset } from './assetLabel'

describe('hctAmountLabel', () => {
  it('names a known asset in whole units with its symbol', () => {
    rememberHctAsset('AA'.repeat(20), { sym: 'wLTC', dec: 8 })
    expect(hctAmountLabel('aa'.repeat(20), '100000')).toBe('0.001 wLTC')
  })

  it('marks an unread asset as raw units, never a bare number', () => {
    expect(hctAmountLabel('bb'.repeat(20), '100000')).toBe('100000 units')
  })
})
