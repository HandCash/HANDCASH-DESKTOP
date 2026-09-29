import { describe, expect, it } from 'vitest'
import {
  BASKET_ABSENCE_MIN_MS,
  BASKET_ABSENCE_MIN_READS,
  isCompleteBasketPage,
  judgeBasketAbsence,
} from './collectableBasketAbsence'

describe('collectableBasketAbsence', () => {
  it('only a non-empty first page shorter than the limit is complete', () => {
    expect(isCompleteBasketPage({ offset: 0, pageLength: 20, pageLimit: 1000 })).toBe(true)
    expect(isCompleteBasketPage({ offset: 0, pageLength: 0, pageLimit: 1000 })).toBe(false)
    expect(isCompleteBasketPage({ offset: 0, pageLength: 1000, pageLimit: 1000 })).toBe(false)
    expect(isCompleteBasketPage({ offset: 1000, pageLength: 3, pageLimit: 1000 })).toBe(false)
  })

  it('retires only after enough consecutive reads spread over enough time', () => {
    const t0 = 1_000_000
    let state = judgeBasketAbsence(null, t0)
    expect(state).toEqual({ next: { misses: 1, since: t0 }, retire: false })
    // Many reads in quick succession are one moment, not a trend.
    for (let i = 0; i < 10; i++) state = judgeBasketAbsence(state.next, t0 + i)
    expect(state.retire).toBe(false)
    // Enough time alone, with too few reads, is not a trend either.
    const late = judgeBasketAbsence({ misses: 1, since: t0 }, t0 + BASKET_ABSENCE_MIN_MS)
    expect(late.retire).toBe(false)
    // Both together retire.
    const enough = judgeBasketAbsence(
      { misses: BASKET_ABSENCE_MIN_READS - 1, since: t0 },
      t0 + BASKET_ABSENCE_MIN_MS,
    )
    expect(enough.retire).toBe(true)
  })
})
