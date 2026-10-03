import { describe, expect, it } from 'vitest'
import { isCompleteBasketPage } from './collectableBasketAbsence'

describe('isCompleteBasketPage', () => {
  it('is the whole basket only on a first page shorter than the limit', () => {
    expect(isCompleteBasketPage({ offset: 0, pageLength: 20, pageLimit: 1000 })).toBe(true)
    expect(isCompleteBasketPage({ offset: 0, pageLength: 0, pageLimit: 1000 })).toBe(true)
    expect(isCompleteBasketPage({ offset: 0, pageLength: 1000, pageLimit: 1000 })).toBe(false)
    expect(isCompleteBasketPage({ offset: 1000, pageLength: 3, pageLimit: 1000 })).toBe(false)
  })
})
