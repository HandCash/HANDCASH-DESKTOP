import { describe, expect, it } from 'vitest'
import { computeListWindow, computeVariableListWindow, fullListWindow, LIST_WINDOW_MIN_ITEMS, sameListWindow, scrollRootScrolledPast } from './list-window.js'

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

  it('moves a stepped window once per step and still covers the viewport plus overscan', () => {
    const at = (row: number) => computeListWindow({ ...base, overscan: 4, step: 4, total: 10_000, scrolledPast: 50 * row })
    const starts = new Set<number>()
    for (let row = 100; row < 120; row++) {
      const w = at(row)
      starts.add(w.start)
      expect(w.start % 4).toBe(0)
      expect(w.start).toBeLessThanOrEqual(row - 4)
      expect(w.end).toBeGreaterThanOrEqual(row + 10 + 4)
      expect(w.padStart + (w.end - w.start) * 50 + w.padEnd).toBe(10_000 * 50)
    }
    expect(starts.size).toBe(5)
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

describe('computeVariableListWindow', () => {
  const pitchOf = (i: number) => (i % 3 === 0 ? 120 : 40)
  const extents = Array.from({ length: 300 }, (_, i) => pitchOf(i))
  const offsetOf = (index: number) => extents.slice(0, index).reduce((sum, h) => sum + h, 0)
  const input = { total: 300, extents, estimate: 60, overscan: 4, viewportHeight: 400, step: 2 }

  it('sizes the spacers from each row, so mounted rows sit where they are drawn', () => {
    const w = computeVariableListWindow({ ...input, scrolledPast: offsetOf(150) })
    expect(w.padStart).toBe(offsetOf(w.start))
    expect(w.padStart + offsetOf(w.end) - offsetOf(w.start) + w.padEnd).toBe(offsetOf(300))
    expect(w.start).toBeLessThanOrEqual(150)
    expect(w.end).toBeGreaterThan(150)
  })

  it('only moves forward on a steady scroll down and always covers the viewport', () => {
    let previous = 0
    for (let past = 0; past <= offsetOf(300) - 400; past += 7) {
      const w = computeVariableListWindow({ ...input, scrolledPast: past })
      expect(w.start).toBeGreaterThanOrEqual(previous)
      expect(w.padStart).toBeLessThanOrEqual(past)
      expect(offsetOf(w.end)).toBeGreaterThanOrEqual(past + 400)
      previous = w.start
    }
  })

  it('reaches both ends of the list', () => {
    expect(computeVariableListWindow({ ...input, scrolledPast: 0 }).start).toBe(0)
    const bottom = computeVariableListWindow({ ...input, scrolledPast: offsetOf(300) - 400 })
    expect(bottom.end).toBe(300)
    expect(bottom.padEnd).toBe(0)
  })

  it('uses the estimate for rows not measured yet', () => {
    const w = computeVariableListWindow({ ...input, extents: [], scrolledPast: 60 * 100 })
    expect(w.padStart).toBe(w.start * 60)
    expect(w.padEnd).toBe((300 - w.end) * 60)
  })
})

describe('scrollRootScrolledPast', () => {
  it('uses scrollTop when the list is its own scroll root', () => {
    const list = { scrollTop: 864 } as HTMLElement
    expect(scrollRootScrolledPast(list, list)).toBe(864)
  })
})
