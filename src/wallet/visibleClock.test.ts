import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class FakeDocument extends EventTarget {
  visibilityState: 'visible' | 'hidden' = 'visible'

  set(state: 'visible' | 'hidden'): void {
    this.visibilityState = state
    this.dispatchEvent(new Event('visibilitychange'))
  }
}

describe('visibleClock', () => {
  let doc: FakeDocument

  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    doc = new FakeDocument()
    vi.stubGlobal('document', doc)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('stands still while the page is hidden', async () => {
    const { visibleNow } = await import('./visibleClock')
    const start = visibleNow()
    vi.advanceTimersByTime(1_000)
    doc.set('hidden')
    vi.advanceTimersByTime(60_000)
    doc.set('visible')
    vi.advanceTimersByTime(500)
    expect(visibleNow() - start).toBe(1_500)
  })

  it('fires a watchdog only after enough visible time', async () => {
    const { setVisibleTimeout } = await import('./visibleClock')
    const fired = vi.fn()
    setVisibleTimeout(fired, 10_000)

    vi.advanceTimersByTime(2_000)
    doc.set('hidden')
    // A throttled WebView: wall time races past the ceiling while nothing ran.
    vi.advanceTimersByTime(120_000)
    expect(fired).not.toHaveBeenCalled()

    doc.set('visible')
    vi.advanceTimersByTime(7_999)
    expect(fired).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1_001)
    expect(fired).toHaveBeenCalledTimes(1)
  })

  it('can be cancelled', async () => {
    const { setVisibleTimeout } = await import('./visibleClock')
    const fired = vi.fn()
    const cancel = setVisibleTimeout(fired, 1_000)
    cancel()
    vi.advanceTimersByTime(5_000)
    expect(fired).not.toHaveBeenCalled()
  })
})
