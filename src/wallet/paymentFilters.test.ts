import { describe, expect, it } from 'vitest'
import type { ActivityEntry } from './appActivity'
import {
  DEFAULT_PAYMENT_FILTERS,
  filterPaymentActivity,
  matchesPaymentFilters,
} from './paymentFilters'

function entry(partial: Partial<ActivityEntry>): ActivityEntry {
  return {
    id: partial.id ?? '1',
    kind: partial.kind ?? 'spent',
    method: partial.method ?? 'send',
    at: partial.at ?? Date.now(),
    sats: partial.sats ?? 1000,
    origin: partial.origin ?? 'wallet',
    ...partial,
  }
}

describe('paymentFilters status', () => {
  it('filters failed rows only', () => {
    const rows = [
      entry({ id: 'ok', status: 'complete' }),
      entry({ id: 'bad', status: 'failed' }),
      entry({ id: 'live', status: 'pending' }),
    ]
    const filtered = filterPaymentActivity(rows, {
      ...DEFAULT_PAYMENT_FILTERS,
      status: 'failed',
    })
    expect(filtered.map((row) => row.id)).toEqual(['bad'])
  })

  it('filters success rows without failed', () => {
    const rows = [
      entry({ id: 'ok', status: 'complete' }),
      entry({ id: 'bad', status: 'failed' }),
      entry({ id: 'live', status: 'pending' }),
    ]
    const filtered = filterPaymentActivity(rows, {
      ...DEFAULT_PAYMENT_FILTERS,
      status: 'success',
    })
    expect(filtered.map((row) => row.id)).toEqual(['ok', 'live'])
  })

  it('matches failed status directly', () => {
    expect(
      matchesPaymentFilters(entry({ status: 'failed' }), {
        ...DEFAULT_PAYMENT_FILTERS,
        status: 'failed',
      }),
    ).toBe(true)
    expect(
      matchesPaymentFilters(entry({ status: 'complete' }), {
        ...DEFAULT_PAYMENT_FILTERS,
        status: 'failed',
      }),
    ).toBe(false)
  })
})
