import { describe, expect, it } from 'vitest'
import {
  activityDetailLabel,
  isItemActivity,
  type ActivityEntry,
} from './appActivity'

function entry(partial: Partial<ActivityEntry>): ActivityEntry {
  return {
    id: '1',
    origin: 'handcash',
    kind: 'spent',
    sats: 1,
    at: 1,
    method: 'send',
    ...partial,
  }
}

describe('activityDetailLabel', () => {
  it('labels collectable rows as Transaction', () => {
    const row = entry({
      method: 'send-collectable',
      item: { name: 'Badge', origin: 'aa_0', outpoint: 'bb.0' },
    })
    expect(isItemActivity(row)).toBe(true)
    expect(activityDetailLabel(row)).toBe('Transaction')
  })

  it('labels app money rows as Payment', () => {
    expect(
      activityDetailLabel(
        entry({ origin: 'https://market.example', method: 'createAction', sats: 1000 }),
      ),
    ).toBe('Payment')
  })

  it('labels wallet BSV sends as Transaction', () => {
    expect(activityDetailLabel(entry({ method: 'send', sats: 5000 }))).toBe('Transaction')
  })
})
