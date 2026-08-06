/**
 * Caps how many images decode at the same time.
 *
 * Ordinals are served at full resolution and a decoded bitmap lives in native
 * memory, not the JS heap — a 2000px square costs ~16MB. Letting a whole grid
 * decode at once is what Android kills the WebView for, with no JS error and no
 * heap warning to show for it.
 *
 * A slot covers the *decode*, so it must be handed back the moment an image
 * settles. Holding it until the component unmounts turns the cap into a
 * deadlock: the first few cards keep their slots while visible and every other
 * card waits forever.
 */

/** Roughly a browser's per-host connection limit; enough to fill a grid promptly. */
export const MAX_CONCURRENT_IMAGE_LOADS = 6

let active = 0
let waiters: Array<() => void> = []

export function acquireImageLoadSlot(): Promise<void> {
  if (active < MAX_CONCURRENT_IMAGE_LOADS) {
    active += 1
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    waiters.push(() => {
      active += 1
      resolve()
    })
  })
}

export function releaseImageLoadSlot(): void {
  active = Math.max(0, active - 1)
  const next = waiters.shift()
  if (next) next()
}

/** Diagnostics and tests. */
export function imageLoadSlotStats(): { active: number; waiting: number } {
  return { active, waiting: waiters.length }
}

export function resetImageLoadSlotsForTests(): void {
  active = 0
  waiters = []
}
