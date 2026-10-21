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
  })
}

/**
 * Windowed slice for long lists and grids. Render `items.slice(start, end)`
 * between spacers of `padStart` / `padEnd` (spread `listWindowPadAttrs`) or
 * as list padding; each row keeps its own data-aeon-* projection.
 *
 * The first render windows from the hints, so a long list never mounts whole.
 * Measuring reads layout, so it runs at most once per frame, and the window is
 * published only when it moves: a scroll inside the current window renders
 * nothing.
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
      keep(hintedWindow({ total, itemExtent, columns, overscan, minItems, axis, scrollRef }))
      return
    }
    const root = resolveScrollRoot(list, axis)
    let frame = 0
    let cancelled = false

    const measureNow = () => {
      const style = getComputedStyle(list)
      keep(
        computeListWindow({
          total,
          rowExtent: measureListRowExtent(list, style, itemExtent, rowSelector, axis),
          columns: axis === 'x' ? 1 : measureListColumns(style, columns),
          overscan,
          scrolledPast: scrollRootScrolledPast(root, list, axis),
          viewportHeight: scrollRootExtent(root, axis),
          minItems,
        }),
      )
    }

    const measure = () => {
      if (cancelled || frame) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        if (!cancelled) measureNow()
      })
    }

    measureNow()
    const target: EventTarget = root === window ? window : root
    target.addEventListener('scroll', measure, { passive: true })
    window.addEventListener('resize', measure)
    return () => {
      cancelled = true
      window.cancelAnimationFrame(frame)
      target.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
    }
  }, [total, itemExtent, columns, overscan, rowSelector, minItems, axis, scrollRef])

  return range
}
