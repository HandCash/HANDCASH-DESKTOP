import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stepOnWheel } from './carouselWheel'

type Wheel = { deltaX: number; deltaY: number; shiftKey: boolean; defaultPrevented: boolean; preventDefault(): void }

function track(width = 300) {
  let listener: ((e: Wheel) => void) | null = null
  const el = {
    clientWidth: width,
    scrollLeft: 0,
    scrollTo: vi.fn((opts: ScrollToOptions) => {
      el.scrollLeft = opts.left ?? 0
    }),
    addEventListener: (_: string, fn: (e: Wheel) => void) => {
      listener = fn
    },
    removeEventListener: () => {
      listener = null
    },
  }
  const wheel = (deltaX: number, deltaY = 0): Wheel => {
    const e: Wheel = {
      deltaX,
      deltaY,
      shiftKey: false,
      defaultPrevented: false,
      preventDefault() {
        e.defaultPrevented = true
      },
    }
    listener?.(e)
    return e
  }
  stepOnWheel(el as unknown as HTMLElement, SLIDES)
  return { scrollTo: el.scrollTo, wheel }
}

let SLIDES = 5

describe('stepOnWheel', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    SLIDES = 5
  })

  it('moves one slide per gesture, however many momentum events follow', () => {
    const { wheel, scrollTo } = track()
    for (let i = 0; i < 40; i++) {
      wheel(60)
      vi.advanceTimersByTime(16)
    }
    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 300, behavior: 'smooth' })
  })

  it('takes the next slide once the gesture has ended', () => {
    const { wheel, scrollTo } = track()
    wheel(60)
    vi.advanceTimersByTime(300)
    wheel(60)
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 600, behavior: 'smooth' })
    vi.advanceTimersByTime(300)
    wheel(-60)
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 300, behavior: 'smooth' })
  })

  it('ignores small nudges, vertical scrolls and the ends of the track', () => {
    SLIDES = 2
    const { wheel, scrollTo } = track()
    expect(wheel(0, 80).defaultPrevented).toBe(false)
    wheel(10)
    expect(scrollTo).not.toHaveBeenCalled()
    vi.advanceTimersByTime(300)
    wheel(-60)
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, behavior: 'smooth' })
    vi.advanceTimersByTime(300)
    wheel(60)
    vi.advanceTimersByTime(300)
    wheel(60)
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 300, behavior: 'smooth' })
  })
})
