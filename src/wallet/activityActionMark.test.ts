import { describe, expect, it } from 'vitest'
import { activityActionMark } from './activityActionMark'
import type { ActivityEntry } from './appActivity'

function entry(overrides: Partial<ActivityEntry> & { method: string }): ActivityEntry {
  return {
    id: overrides.method,
    origin: 'handcash.wallet',
    kind: 'earned',
    sats: 1,
    at: 1,
    ...overrides,
  } as ActivityEntry
}

describe('activityActionMark', () => {
  it('marks every market action apart from the others', () => {
    const marks = [
      'market-list',
      'market-cancel',
      'market-sale',
      'market-purchase',
    ].map((method) => activityActionMark(entry({ method, kind: 'event', sats: 0 })))
    expect(marks).toEqual(['list', 'cancel', 'sale', 'purchase'])
    expect(new Set(marks).size).toBe(marks.length)
  })

  it('marks both legs of a sale and of a purchase with their own action', () => {
    expect(
      activityActionMark(entry({ method: 'market-sale-proceeds', sats: 8_550 })),
    ).toBe('sale')
    expect(
      activityActionMark(entry({ method: 'market-purchase-receive' })),
    ).toBe('purchase')
  })

  it('never marks a sale as a send just because the item left', () => {
    expect(
      activityActionMark(entry({ method: 'market-sale', kind: 'spent', sats: 1 })),
    ).toBe('sale')
  })

  it('marks plain transfers by direction', () => {
    expect(activityActionMark(entry({ method: 'send', kind: 'spent', sats: 500 }))).toBe(
      'send',
    )
    expect(activityActionMark(entry({ method: 'receive', sats: 500 }))).toBe('receive')
  })

  it('marks a failed row as failed ahead of its action', () => {
    expect(
      activityActionMark(
        entry({ method: 'send-collectable', kind: 'spent', sats: 1, status: 'failed' }),
      ),
    ).toBe('failed')
  })

  it('leaves rows that record no action unmarked', () => {
    expect(activityActionMark(entry({ method: 'connect', kind: 'event', sats: 0 }))).toBeNull()
    expect(
      activityActionMark(entry({ method: 'add-friend', kind: 'event', sats: 0 })),
    ).toBeNull()
    expect(
      activityActionMark(entry({ method: 'index-install', kind: 'event', sats: 0 })),
    ).toBeNull()
  })
})
