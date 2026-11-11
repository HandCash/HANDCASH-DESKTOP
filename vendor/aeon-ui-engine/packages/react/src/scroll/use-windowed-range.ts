import {
  computeListWindow,
  computeVariableListWindow,
  fullListWindow,
  LIST_WINDOW_MIN_ITEMS,
  LIST_WINDOW_PAD_ATTR,
  measureListColumns,
  measureListRowExtent,
  resolveScrollRoot,
  sameListWindow,
  scrollRootExtent,
  scrollRootScrolledPast,
  type ListWindow,
  type ListWindowAxis,
} from '@aeon-ui/core'
import { useLayoutEffect, useRef, useState, type RefObject } from 'react'

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

/** Pitches of one-column rows seen so far, by item index, for one `total`. */
interface RowSizes {
  total: number
  extents: number[]
  sum: number
  count: number
  /**
   * Pitch for rows not measured yet, fixed from the first rows measured. A
   * running average moved the spacer over rows a fling skipped on every
   * measurement, so the content shifted under a scroll still in flight.
   */
  estimate: number
  /** Offset of the first windowed element (start spacer or row) inside the list. */
  head: number
}

const emptySizes = (total: number): RowSizes => ({ total, extents: [], sum: 0, count: 0, estimate: 0, head: 0 })

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
 * A one-column list measures each mounted row once per window move and sizes
 * its spacers from those heights, so rows of different heights never shift the
 * content above the viewport. Grids share one measured pitch. A scroll frame
 * reads only the scroll offset; the window moves `step` rows at a time and is
 * published only when it moves, so a scroll inside the window renders nothing.
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
  const sizesRef = useRef<RowSizes>(emptySizes(total))
  const rootRef = useRef<HTMLElement | Window | null>(null)
  const remeasureRef = useRef<(() => void) | null>(null)

  useLayoutEffect(() => {
    const keep = (next: ListWindow) => setRange((current) => (sameListWindow(current, next) ? current : next))
    remeasureRef.current = null
    // Indices shift when the list changes length, so earlier pitches no longer line up.
    if (sizesRef.current.total !== total) sizesRef.current = emptySizes(total)
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
    rootRef.current = root
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
      const viewportHeight = scrollRootExtent(root, axis)
      // A hidden list (a keep-alive tab) has no viewport; keep its window for when it shows.
      if (viewportHeight <= 0) return
      const scrolledPast = scrollRootScrolledPast(root, list, axis)
      const sizes = sizesRef.current
      const next =
        cols === 1
          ? computeVariableListWindow({
              total,
              extents: sizes.extents,
              estimate: sizes.estimate || rowExtent,
              overscan,
              scrolledPast: scrolledPast - sizes.head,
              viewportHeight,
              minItems,
              step,
            })
          : computeListWindow({
              total,
              rowExtent,
              columns: cols,
              overscan,
              scrolledPast,
              viewportHeight,
              minItems,
              step,
            })
      if (published && sameListWindow(published, next)) return
      // New grid rows mount with this window; their pitch is read on the next move.
      if (published && cols !== 1) layout = null
      published = next
      keep(next)
    }
    remeasureRef.current = measureNow

    const schedule = () => {
      if (cancelled || frame) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        if (!cancelled) measureNow()
      })
    }
    const onResize = () => {
      layout = null
      sizesRef.current = emptySizes(total)
      schedule()
    }
    // Row heights follow the list's width. A list shown again (0 → its size)
    // keeps them and only re-windows: no scroll event announces that.
    let width = list.clientWidth
    const observer =
      root !== window && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            const next = list.clientWidth
            if (next > 0 && width > 0 && next !== width) onResize()
            else schedule()
            if (next > 0) width = next
          })
        : null
    observer?.observe(root as HTMLElement)

    measureNow()
    const target: EventTarget = root === window ? window : root
    target.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', onResize)
    return () => {
      cancelled = true
      remeasureRef.current = null
      window.cancelAnimationFrame(frame)
      observer?.disconnect()
      target.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', onResize)
    }
  }, [total, itemExtent, columns, overscan, rowSelector, minItems, axis, scrollRef, step])

  // Once per window move: record the pitch of every mounted row of a one-column list.
  useLayoutEffect(() => {
    const list = scrollRef.current
    const root = rootRef.current
    const sizes = sizesRef.current
    if (!list || !root || total < minItems || sizes.total !== total) return
    const style = getComputedStyle(list)
    if (axis === 'y' && measureListColumns(style, columns) !== 1) return
    const listRect = list.getBoundingClientRect()
    if ((axis === 'x' ? listRect.width : listRect.height) <= 0) return
    const gap = Number.parseFloat(axis === 'x' ? style.columnGap : style.rowGap)
    const gapPx = Number.isFinite(gap) ? gap : 0
    const scrolled = root === list ? (axis === 'x' ? list.scrollLeft : list.scrollTop) : 0
    let index = range.start
    let head: number | null = null
    let changed = false
    for (const node of Array.from(list.children)) {
      if (!(node instanceof HTMLElement)) continue
      const pad = node.getAttribute(LIST_WINDOW_PAD_ATTR)
      if (pad === 'end' || index >= range.end) break
      const isRow = !pad && (!rowSelector || node.matches(rowSelector))
      if (pad !== 'start' && !isRow) continue
      const rect = node.getBoundingClientRect()
      if (head === null) head = (axis === 'x' ? rect.left - listRect.left : rect.top - listRect.top) + scrolled
      if (!isRow) continue
      const size = axis === 'x' ? rect.width : rect.height
      if (size > 0) {
        const extent = size + gapPx
        const before = sizes.extents[index]
        if (before === undefined || Math.abs(before - extent) > 0.5) {
          if (before === undefined) sizes.count += 1
          else sizes.sum -= before
          sizes.extents[index] = extent
          sizes.sum += extent
          changed = true
        }
      }
      index += 1
    }
    if (!sizes.estimate && sizes.count > 0) {
      sizes.estimate = sizes.sum / sizes.count
      changed = true
    }
    if (head !== null && Math.abs(head - sizes.head) > 0.5) {
      sizes.head = head
      changed = true
    }
    if (changed) remeasureRef.current?.()
  }, [range, total, minItems, columns, rowSelector, axis, scrollRef])

  return range
}
