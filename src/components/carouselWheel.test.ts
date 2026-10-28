import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stepOnPointer, stepOnWheel } from './carouselWheel'

type Wheel = { deltaX: number; deltaY: number; shiftKey: boolean; defaultPrevented: boolean; preventDefault(): void }

function track(width = 300) {
  let listener: ((e: Wheel) => void) | null = null
  const el = {
    clientWidth: width,
    scrollLeft: 0,
    scrollTo: vi.fn((opts: ScrollToOptions) => {
      el.scrollLeft = opts.left ?? 0
    }),
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    addEventListener: (type: string, fn: (e: Wheel) => void) => {
      if (type === 'wheel') listener = fn
    },
    removeEventListener: (type: string) => {
      if (type === 'wheel') listener = null
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

type Ptr = {
  pointerId: number
  pointerType: string
  button: number
  clientX: number
  clientY: number
  target: EventTarget | null
  defaultPrevented: boolean
  preventDefault(): void
}

function pointerTrack(width = 300) {
  const listeners = new Map<string, (e: Ptr) => void>()
  const el = {
    clientWidth: width,
    scrollLeft: 0,
    scrollTo: vi.fn((opts: ScrollToOptions) => {
      el.scrollLeft = opts.left ?? 0
    }),
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    addEventListener: (type: string, fn: (e: Ptr) => void) => {
      listeners.set(type, fn)
    },
    removeEventListener: (type: string) => {
      listeners.delete(type)
    },
  }
  const onFlick = vi.fn()
  stepOnPointer(el as unknown as HTMLElement, SLIDES, onFlick)
  const fire = (type: string, partial: Partial<Ptr>) => {
    const e: Ptr = {
      pointerId: 1,
      pointerType: 'touch',
      button: 0,
      clientX: 0,
      clientY: 0,
      target: el as unknown as EventTarget,
      defaultPrevented: false,
      preventDefault() {
        e.defaultPrevented = true
      },
      ...partial,
    }
    listeners.get(type)?.(e)
    return e
  }
  return { el, scrollTo: el.scrollTo, fire, onFlick }
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

describe('stepOnPointer', () => {
  afterEach(() => {
    SLIDES = 5
  })

  it('flicks exactly one slide, however far the finger travels', () => {
    const { fire, scrollTo, onFlick, el } = pointerTrack()
    fire('pointerdown', { clientX: 200, clientY: 10 })
    fire('pointermove', { clientX: 180, clientY: 10 })
    // Still under flick threshold — no capture yet.
    expect(el.setPointerCapture).not.toHaveBeenCalled()
    fire('pointermove', { clientX: 20, clientY: 12 })
    expect(el.setPointerCapture).toHaveBeenCalled()
    expect(el.scrollLeft).toBe(180)
    fire('pointerup', { clientX: 20, clientY: 12 })
    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 300, behavior: 'smooth' })
    expect(onFlick).toHaveBeenCalledTimes(1)
  })

  it('leaves a short drag alone so the coin-trigger click can fire', () => {
    const { fire, scrollTo, onFlick, el } = pointerTrack()
    fire('pointerdown', { clientX: 100, clientY: 10 })
    fire('pointermove', { clientX: 80, clientY: 10 })
    const up = fire('pointerup', { clientX: 80, clientY: 10 })
    expect(el.setPointerCapture).not.toHaveBeenCalled()
    expect(up.defaultPrevented).toBe(false)
    expect(scrollTo).not.toHaveBeenCalled()
    expect(onFlick).not.toHaveBeenCalled()

    fire('pointerdown', { clientX: 100, clientY: 10 })
    const tapUp = fire('pointerup', { clientX: 102, clientY: 11 })
    expect(tapUp.defaultPrevented).toBe(false)
    expect(onFlick).not.toHaveBeenCalled()
  })

  it('lets a vertical drag go so the page can scroll', () => {
    const { fire, scrollTo, el } = pointerTrack()
    fire('pointerdown', { clientX: 100, clientY: 10 })
    fire('pointermove', { clientX: 102, clientY: 40 })
    expect(el.setPointerCapture).not.toHaveBeenCalled()
    fire('pointerup', { clientX: 102, clientY: 80 })
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('ignores pointerdowns that start on the coin trigger', () => {
    const { fire, scrollTo, onFlick, el } = pointerTrack()
    const trigger = { closest: (sel: string) => (sel.includes('coin-trigger') ? trigger : null) }
    fire('pointerdown', {
      clientX: 100,
      clientY: 10,
      target: trigger as unknown as EventTarget,
    })
    fire('pointermove', { clientX: 20, clientY: 10 })
    fire('pointerup', { clientX: 20, clientY: 10 })
    expect(el.setPointerCapture).not.toHaveBeenCalled()
    expect(scrollTo).not.toHaveBeenCalled()
    expect(onFlick).not.toHaveBeenCalled()
  })
})
