import { describe, expect, it } from 'vitest'
import { shouldAttachDeferredSrc } from './attachSrc'

describe('shouldAttachDeferredSrc', () => {
  it('keeps src while intersecting even if the decode slot was released', () => {
    expect(
      shouldAttachDeferredSrc({
        retained: false,
        near: true,
        loadSlot: false,
        intersecting: true,
        ready: true,
      }),
    ).toBe(true)
  })

  it('does not attach far-away inventory thumbs until they are near', () => {
    expect(
      shouldAttachDeferredSrc({
        retained: false,
        near: false,
        loadSlot: false,
        intersecting: false,
        ready: false,
      }),
    ).toBe(false)
  })

  it('never clears a retained decoded thumb', () => {
    expect(
      shouldAttachDeferredSrc({
        retained: true,
        near: false,
        loadSlot: false,
        intersecting: false,
        ready: true,
      }),
    ).toBe(true)
  })
})
