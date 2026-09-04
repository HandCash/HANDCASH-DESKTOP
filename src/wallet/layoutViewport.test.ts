import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  COMPACT_MAX_WIDTH_PX,
  isCompactLayout,
  resetLayoutViewportForTests,
  startLayoutViewport,
  subscribeCompactLayout,
} from './layoutViewport'

function stubViewport(width: number, height: number) {
  const root = {
    classList: {
      _set: new Set<string>(),
      toggle(name: string, force?: boolean) {
        if (force) this._set.add(name)
        else this._set.delete(name)
      },
      contains(name: string) {
        return this._set.has(name)
      },
      remove(name: string) {
        this._set.delete(name)
      },
    },
  }
  const listeners = new Map<string, Set<EventListener>>()
  vi.stubGlobal('window', {
    innerWidth: width,
    innerHeight: height,
    addEventListener(type: string, fn: EventListener) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(fn)
    },
    dispatchEvent(ev: Event) {
      for (const fn of listeners.get(ev.type) ?? []) fn(ev)
      return true
    },
  })
  vi.stubGlobal('document', { documentElement: root })
  return { root, listeners, setSize(w: number, h: number) {
    ;(window as { innerWidth: number }).innerWidth = w
    ;(window as { innerHeight: number }).innerHeight = h
  } }
}

afterEach(() => {
  resetLayoutViewportForTests()
  vi.unstubAllGlobals()
})

describe('layoutViewport', () => {
  it('is compact when taller than wide', () => {
    const { root } = stubViewport(600, 900)
    startLayoutViewport()
    expect(isCompactLayout()).toBe(true)
    expect(root.classList.contains('layout-compact')).toBe(true)
  })

  it('is compact when narrower than the tile threshold', () => {
    stubViewport(COMPACT_MAX_WIDTH_PX, 500)
    startLayoutViewport()
    expect(isCompactLayout()).toBe(true)
  })

  it('is wide when landscape and above the threshold', () => {
    const { root } = stubViewport(1180, 760)
    startLayoutViewport()
    expect(isCompactLayout()).toBe(false)
    expect(root.classList.contains('layout-compact')).toBe(false)
  })

  it('notifies subscribers on resize into portrait', () => {
    const ctx = stubViewport(1180, 760)
    startLayoutViewport()
    const seen: boolean[] = []
    const unsub = subscribeCompactLayout((c) => {
      seen.push(c)
    })
    ctx.setSize(500, 900)
    window.dispatchEvent(new Event('resize'))
    expect(seen.at(-1)).toBe(true)
    unsub()
  })

  it('start is idempotent', () => {
    stubViewport(1180, 760)
    const add = vi.spyOn(window, 'addEventListener')
    startLayoutViewport()
    startLayoutViewport()
    const resizeCalls = add.mock.calls.filter((c) => c[0] === 'resize')
    expect(resizeCalls).toHaveLength(1)
    add.mockRestore()
  })
})
