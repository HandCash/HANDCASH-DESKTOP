import {
  computeListWindow,
  fullListWindow,
  LIST_WINDOW_MIN_ITEMS,
  measureListColumns,
  measureListRowExtent,
  resolveScrollRoot,
  sameListWindow,
  scrollRootExtent,
  scrollRootScrolledPast,
  type ListWindow,
  type ListWindowAxis,
} from '@aeon-ui/core'
import { useLayoutEffect, useState, type RefObject } from 'react'

export interface UseWindowedRangeOptions {
  total: number
  /** Fallback row pitch, used until a row can be measured. */
  itemExtent: number
  /** Fallback column count for grids; the real count is read from the grid. */
  columns?: number
  overscan?: number
  /** Restrict measuring to real rows when the list also holds other chrome. */
  rowSelector?: string
  minItems?: number
  /** `x` windows a horizontal strip by item width; columns do not apply. */
  axis?: ListWindowAxis
  /** The list element itself; its scrollable ancestor drives the window. */
  scrollRef: RefObject<HTMLElement | null>
  /** Rows the window moves at a time; defaults to half the overscan. */
  step?: number
}

function hintedWindow(o: UseWindowedRangeOptions): ListWindow {
  return computeListWindow({
    total: o.total,
    rowExtent: o.itemExtent,
    columns: o.axis === 'x' ? 1 : o.columns,
    overscan: o.overscan,
    scrolledPast: 0,
    viewportHeight: typeof window === 'undefined' ? 0 : o.axis === 'x' ? window.innerWidth : window.innerHeight,
    minItems: o.minItems,
    step: o.step ?? Math.max(1, Math.floor((o.overscan ?? 8) / 2)),
  })
}

/**
 * Windowed slice for long lists and grids. Render `items.slice(start, end)`
 * between spacers of `padStart` / `padEnd` (spread `listWindowPadAttrs`) or
 * as list padding; each row keeps its own data-aeon-* projection.
 *
 * The first render windows from the hints, so a long list never mounts whole.
 * Row pitch and columns are measured when the effect starts, on resize, and
 * until a real row exists; a scroll frame reads only the scroll offset. The
 * window moves `step` rows at a time and is published only when it moves, so a
 * scroll inside the current window renders nothing.
 */
export function useWindowedRange(options: UseWindowedRangeOptions): ListWindow {
  const {
    total,
    itemExtent,
    columns = 1,
    overscan = 8,
    rowSelector,
    minItems = LIST_WINDOW_MIN_ITEMS,
    axis = 'y',
    scrollRef,
    step = Math.max(1, Math.floor(overscan / 2)),
  } = options
  const [range, setRange] = useState<ListWindow>(() => hintedWindow(options))

  useLayoutEffect(() => {
    const keep = (next: ListWindow) => setRange((current) => (sameListWindow(current, next) ? current : next))
    if (total < minItems) {
      keep(fullListWindow(total))
      return
    }
    const list = scrollRef.current
    if (!list) {
      keep(hintedWindow({ total, itemExtent, columns, overscan, minItems, axis, scrollRef, step }))
      return
    }
    const root = resolveScrollRoot(list, axis)
    let frame = 0
    let cancelled = false
    let layout: { rowExtent: number; columns: number } | null = null
    let published: ListWindow | null = null

    const readLayout = () => {
      if (layout) return layout
      const style = getComputedStyle(list)
      const rowExtent = measureListRowExtent(list, style, itemExtent, rowSelector, axis)
      const next = { rowExtent, columns: axis === 'x' ? 1 : measureListColumns(style, columns) }
      // The hint stands in until a real row has mounted; measure again then.
      if (rowExtent !== itemExtent) layout = next
      return next
    }

    const measureNow = () => {
      const { rowExtent, columns: cols } = readLayout()
      const next = computeListWindow({
        total,
        rowExtent,
        columns: cols,
        overscan,
        scrolledPast: scrollRootScrolledPast(root, list, axis),
        viewportHeight: scrollRootExtent(root, axis),
        minItems,
        step,
      })
      if (published && sameListWindow(published, next)) return
      // New rows mount with this window; their pitch is read on the next move.
      if (published) layout = null
      published = next
      keep(next)
    }

    const schedule = () => {
      if (cancelled || frame) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        if (!cancelled) measureNow()
      })
    }
    const onResize = () => {
      layout = null
      schedule()
    }

    measureNow()
    const target: EventTarget = root === window ? window : root
    target.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', onResize)
    return () => {
      cancelled = true
      window.cancelAnimationFrame(frame)
      target.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', onResize)
    }
  }, [total, itemExtent, columns, overscan, rowSelector, minItems, axis, scrollRef, step])

  return range
}
