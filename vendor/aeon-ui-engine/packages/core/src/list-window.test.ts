import { describe, expect, it } from 'vitest'
import { computeListWindow, fullListWindow, LIST_WINDOW_MIN_ITEMS, sameListWindow, scrollRootScrolledPast } from './list-window.js'

const base = { rowExtent: 50, viewportHeight: 500, overscan: 2 }

describe('computeListWindow', () => {
  it('mounts a short list whole', () => {
    expect(computeListWindow({ ...base, total: LIST_WINDOW_MIN_ITEMS - 1, scrolledPast: 0 })).toEqual(
      fullListWindow(LIST_WINDOW_MIN_ITEMS - 1),
    )
  })

  it('mounts only the viewport plus overscan at the top of a long list', () => {
    const w = computeListWindow({ ...base, total: 10_000, scrolledPast: 0 })
    expect(w).toEqual({ start: 0, end: 14, padStart: 0, padEnd: (10_000 - 14) * 50 })
  })

  it('keeps the scroll height whole while scrolled into the middle', () => {
    const w = computeListWindow({ ...base, total: 10_000, scrolledPast: 50 * 5_000 })
    expect(w.start).toBe(4_998)
    expect(w.end - w.start).toBe(14)
    expect(w.padStart + (w.end - w.start) * 50 + w.padEnd).toBe(10_000 * 50)
  })

  it('pins the last window to the end instead of running past it', () => {
    const w = computeListWindow({ ...base, total: 1_000, scrolledPast: 50 * 5_000 })
    expect(w).toEqual({ start: 986, end: 1_000, padStart: 986 * 50, padEnd: 0 })
  })

  it('windows a grid by whole rows', () => {
    const w = computeListWindow({ ...base, total: 1_001, columns: 4, scrolledPast: 50 * 100 })
    expect(w.start % 4).toBe(0)
    expect(w.start).toBe(98 * 4)
    expect(w.end).toBe(112 * 4)
    expect(w.padEnd).toBe((Math.ceil(1_001 / 4) - 112) * 50)
  })

  it('falls back to the whole list when the row pitch is unknown', () => {
    expect(computeListWindow({ ...base, rowExtent: 0, total: 500, scrolledPast: 0 })).toEqual(fullListWindow(500))
  })

  it('compares windows by value', () => {
    expect(sameListWindow(fullListWindow(3), fullListWindow(3))).toBe(true)
    expect(sameListWindow(fullListWindow(3), fullListWindow(4))).toBe(false)
  })
})

describe('scrollRootScrolledPast', () => {
  it('uses scrollTop when the list is its own scroll root', () => {
    const list = { scrollTop: 864 } as HTMLElement
    expect(scrollRootScrolledPast(list, list)).toBe(864)
  })
})
