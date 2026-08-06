import { beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_CONCURRENT_IMAGE_LOADS,
  acquireImageLoadSlot,
  imageLoadSlotStats,
  releaseImageLoadSlot,
  resetImageLoadSlotsForTests,
} from './imageLoadSlots'

describe('imageLoadSlots', () => {
  beforeEach(resetImageLoadSlotsForTests)

  it('hands out slots immediately up to the cap', async () => {
    for (let i = 0; i < MAX_CONCURRENT_IMAGE_LOADS; i++) {
      await acquireImageLoadSlot()
    }
    expect(imageLoadSlotStats()).toEqual({
      active: MAX_CONCURRENT_IMAGE_LOADS,
      waiting: 0,
    })
  })

  it('queues past the cap and never over-admits', async () => {
    for (let i = 0; i < MAX_CONCURRENT_IMAGE_LOADS; i++) await acquireImageLoadSlot()

    let admitted = false
    void acquireImageLoadSlot().then(() => {
      admitted = true
    })
    await Promise.resolve()

    expect(admitted).toBe(false)
    expect(imageLoadSlotStats().waiting).toBe(1)
  })

  it('a released slot admits the next waiter', async () => {
    for (let i = 0; i < MAX_CONCURRENT_IMAGE_LOADS; i++) await acquireImageLoadSlot()

    const queued = acquireImageLoadSlot()
    releaseImageLoadSlot()
    await queued

    expect(imageLoadSlotStats()).toEqual({
      active: MAX_CONCURRENT_IMAGE_LOADS,
      waiting: 0,
    })
  })

  /**
   * The v0.1.39 bug: slots were only returned on unmount, so once the first
   * few visible cards had loaded, every remaining image waited forever.
   */
  it('drains a full grid when each image releases as it settles', async () => {
    const total = 40
    let settled = 0

    await Promise.all(
      Array.from({ length: total }, async () => {
        await acquireImageLoadSlot()
        settled += 1
        releaseImageLoadSlot()
      }),
    )

    expect(settled).toBe(total)
    expect(imageLoadSlotStats()).toEqual({ active: 0, waiting: 0 })
  })

  it('holding slots without releasing starves the rest — the regression guard', async () => {
    for (let i = 0; i < MAX_CONCURRENT_IMAGE_LOADS; i++) await acquireImageLoadSlot()

    let loaded = 0
    for (let i = 0; i < 10; i++) {
      void acquireImageLoadSlot().then(() => {
        loaded += 1
      })
    }
    await Promise.resolve()
    expect(loaded).toBe(0)

    // Returning the held slots is what lets the grid finish.
    for (let i = 0; i < MAX_CONCURRENT_IMAGE_LOADS; i++) releaseImageLoadSlot()
    await Promise.resolve()
    await Promise.resolve()
    expect(loaded).toBe(MAX_CONCURRENT_IMAGE_LOADS)
  })

  it('an extra release cannot push the count negative', () => {
    releaseImageLoadSlot()
    releaseImageLoadSlot()
    expect(imageLoadSlotStats().active).toBe(0)
  })

  it('a cancelled waiter passes its slot along instead of losing it', async () => {
    for (let i = 0; i < MAX_CONCURRENT_IMAGE_LOADS; i++) await acquireImageLoadSlot()

    // First waiter gives up the moment it is admitted (frame scrolled away).
    void acquireImageLoadSlot().then(() => releaseImageLoadSlot())

    let secondAdmitted = false
    void acquireImageLoadSlot().then(() => {
      secondAdmitted = true
    })

    releaseImageLoadSlot()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(secondAdmitted).toBe(true)
  })
})
