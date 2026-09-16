import { describe, expect, it } from 'vitest'
import { deferredFallbackFrame } from './fallbackFrame'

describe('deferred fallback frame', () => {
  it('fills the square the image would have filled, so the glyph centres', () => {
    expect(deferredFallbackFrame({ showFallback: true, width: 120, height: 120 })).toEqual({
      width: 120,
      height: 120,
    })
  })

  it('leaves a loaded image to size itself', () => {
    expect(
      deferredFallbackFrame({ showFallback: false, width: 120, height: 120 }),
    ).toBeUndefined()
  })

  it('fills its container when the caller gave no fixed size', () => {
    expect(deferredFallbackFrame({ showFallback: true })).toEqual({
      width: '100%',
      height: '100%',
    })
  })
})
