import {
  computeListWindow,
  fullListWindow,
  LIST_WINDOW_MIN_ITEMS,
  LIST_WINDOW_PAD_ATTR,
  measureListColumns,
  measureListRowExtent,
  resolveScrollRoot,
  sameListWindow,
  scrollRootExtent,
  type ListWindow,
  type ListWindowAxis,
} from '@aeon-ui/core'
import {
  elementScroll,
  observeElementOffset,
  observeWindowOffset,
  Virtualizer,
  windowScroll,
  type Range,
  type Rect,
  type VirtualizerOptions,
} from '@tanstack/virtual-core'
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

type Root = HTMLElement | Window
type RowVirtualizer = Virtualizer<Root, HTMLElement>

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
 * Rows to mount for a visible range. The end is counted from the lead row's
 * top, so scrolling within a row keeps the same end, and both edges snap to
 * multiples of `step`, so a fling re-renders once per step, not per row.
 */
function steppedRows(virtualizer: RowVirtualizer, range: Range, viewport: number, step: number): number[] {
  const rows = virtualizer.measurementsCache
  const lead = rows[range.startIndex]
  let last = range.endIndex
  if (lead) {
    const bottom = lead.start + viewport
    last = range.startIndex
    while (last < range.count - 1 && rows[last]!.end < bottom) last += 1
  }
  const start = Math.floor(Math.max(0, range.startIndex - range.overscan) / step) * step
  const end = Math.min(range.count, Math.ceil((last + 1 + range.overscan) / step) * step)
  return Array.from({ length: Math.max(0, end - start) }, (_, i) => start + i)
}

const scrollOffsetOf = (root: Root, axis: ListWindowAxis): number =>
  root === window
    ? axis === 'x'
      ? window.scrollX
      : window.scrollY
    : axis === 'x'
      ? (root as HTMLElement).scrollLeft
      : (root as HTMLElement).scrollTop

const edgeOf = (root: Root, axis: ListWindowAxis): number => {
  if (root === window) return 0
  const rect = (root as HTMLElement).getBoundingClientRect()
  return axis === 'x' ? rect.left : rect.top
}

const rectOf = (root: Root): Rect => ({ width: scrollRootExtent(root, 'x'), height: scrollRootExtent(root, 'y') })

/**
 * Windowed slice for long lists and grids. Render `items.slice(start, end)`
 * between spacers of `padStart` / `padEnd` (spread `listWindowPadAttrs`) or
 * as list padding; each row keeps its own data-aeon-* projection.
 *
 * The first render windows from the hints, so a long list never mounts whole.
 * After mount a TanStack virtualizer on the scroll root owns the range: it
 * follows scroll and resize, keeps every measured row pitch, and finds the
 * window by binary search. A one-column list measures each mounted row once
 * per window move; grids window whole rows of one measured pitch. The window
 * moves `step` rows at a time and is published only when it moves, so a
 * scroll inside the window renders nothing.
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
  const measureRef = useRef<((window: ListWindow) => void) | null>(null)

  useLayoutEffect(() => {
    const keep = (next: ListWindow) => setRange((current) => (sameListWindow(current, next) ? current : next))
    measureRef.current = null
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
    const horizontal = axis === 'x'
    const columnsOf = (style: CSSStyleDeclaration) => (horizontal ? 1 : measureListColumns(style, columns))
    let style = getComputedStyle(list)
    let cols = columnsOf(style)
    let pitch = measureListRowExtent(list, style, itemExtent, rowSelector, axis)
    // Pitch for rows not measured yet, fixed from the first rows measured. A
    // running average moved the spacer over rows a fling skipped on every
    // measurement, so the content shifted under a scroll still in flight.
    let estimate = 0
    let width = list.clientWidth
    let reportOffset: ((offset: number, isScrolling: boolean) => void) | null = null

    const optionsFor = (scrollMargin: number): VirtualizerOptions<Root, HTMLElement> => ({
      count: cols === 1 ? total : Math.ceil(total / cols),
      getScrollElement: () => root,
      estimateSize: () => (cols === 1 && estimate) || pitch,
      horizontal,
      overscan,
      scrollMargin,
      rangeExtractor: (visible) => steppedRows(virtualizer, visible, scrollRootExtent(root, axis), step),
      initialOffset: () => scrollOffsetOf(root, axis),
      initialRect: rectOf(root),
      observeElementRect: (_instance, onRect) => {
        const read = () => {
          // Row heights follow the list's width. A list shown again (0 → its
          // size) keeps them and only re-windows: no scroll event announces it,
          // and its offset only comes back with the box.
          const next = list.clientWidth
          if (next > 0 && width > 0 && next !== width) relayout()
          if (next > 0) width = next
          reportOffset?.(scrollOffsetOf(root, axis), false)
          onRect(rectOf(root))
        }
        read()
        if (root === window) {
          window.addEventListener('resize', read, { passive: true })
          return () => window.removeEventListener('resize', read)
        }
        if (typeof ResizeObserver === 'undefined') return
        const observer = new ResizeObserver(read)
        observer.observe(root as HTMLElement)
        return () => observer.disconnect()
      },
      observeElementOffset: (instance, onOffset) => {
        reportOffset = onOffset
        return root === window
          ? observeWindowOffset(instance as unknown as Virtualizer<Window, HTMLElement>, onOffset)
          : observeElementOffset(instance as unknown as Virtualizer<HTMLElement, HTMLElement>, onOffset)
      },
      scrollToFn: (offset, write, instance) =>
        root === window
          ? windowScroll(offset, write, instance as unknown as Virtualizer<Window, HTMLElement>)
          : elementScroll(offset, write, instance as unknown as Virtualizer<HTMLElement, HTMLElement>),
      onChange: () => publish(),
    })

    const virtualizer: RowVirtualizer = new Virtualizer(
      optionsFor(root === list ? 0 : scrollOffsetOf(root, axis) + edgeOf(list, axis) - edgeOf(root, axis)),
    )
    // Spacers sit in flow, so the browser's scroll anchoring already holds the
    // rows in view when one above changes size; a second correction written to
    // scrollTop would double it and stop a fling.
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false

    function relayout() {
      estimate = 0
      style = getComputedStyle(list!)
      cols = columnsOf(style)
      pitch = measureListRowExtent(list!, style, itemExtent, rowSelector, axis)
      virtualizer.setOptions(optionsFor(virtualizer.options.scrollMargin))
      virtualizer.measure()
    }

    function publish() {
      // A hidden list (a keep-alive tab) has no viewport; keep its window for when it shows.
      if (scrollRootExtent(root, axis) <= 0) return
      const rows = virtualizer.getVirtualItems()
      const first = rows[0]
      const last = rows[rows.length - 1]
      if (!first || !last) return
      const margin = virtualizer.options.scrollMargin
      keep({
        start: first.index * cols,
        end: Math.min(total, (last.index + 1) * cols),
        padStart: first.start - margin,
        padEnd: Math.max(0, virtualizer.getTotalSize() - (last.end - margin)),
      })
    }

    // Once per window move: where the rows begin, and the pitch of every mounted row of a one-column list.
    measureRef.current = (shown) => {
      const listRect = list.getBoundingClientRect()
      if ((horizontal ? listRect.width : listRect.height) <= 0) return
      style = getComputedStyle(list)
      if (
        columnsOf(style) !== cols ||
        (cols !== 1 && Math.abs(measureListRowExtent(list, style, pitch, rowSelector, axis) - pitch) > 0.5)
      ) {
        relayout()
        return
      }
      const gap = Number.parseFloat(horizontal ? style.columnGap : style.rowGap)
      const gapPx = Number.isFinite(gap) ? gap : 0
      const pitches: Array<[number, number]> = []
      let head: number | null = null
      let index = shown.start
      for (const node of Array.from(list.children)) {
        if (!(node instanceof HTMLElement)) continue
        const pad = node.getAttribute(LIST_WINDOW_PAD_ATTR)
        if (pad === 'end' || index >= shown.end) break
        const isRow = !pad && (!rowSelector || node.matches(rowSelector))
        if (pad !== 'start' && !isRow) continue
        const rect = node.getBoundingClientRect()
        if (head === null) head = horizontal ? rect.left : rect.top
        if (!isRow) continue
        if (cols !== 1) break
        const size = horizontal ? rect.width : rect.height
        if (size > 0) pitches.push([index, size + gapPx])
        index += 1
      }
      let moved = false
      if (head !== null) {
        const margin = scrollOffsetOf(root, axis) + head - edgeOf(root, axis)
        if (Math.abs(margin - virtualizer.options.scrollMargin) > 0.5) {
          virtualizer.setOptions(optionsFor(margin))
          moved = true
        }
      }
      if (!estimate && pitches.length > 0) {
        estimate = pitches.reduce((sum, [, size]) => sum + size, 0) / pitches.length
        virtualizer.measure()
      }
      for (const [row, size] of pitches) virtualizer.resizeItem(row, size)
      if (moved) publish()
    }

    const unmount = virtualizer._didMount()
    virtualizer._willUpdate()
    publish()
    return () => {
      measureRef.current = null
      unmount()
    }
  }, [total, itemExtent, columns, overscan, rowSelector, minItems, axis, scrollRef, step])

  useLayoutEffect(() => {
    measureRef.current?.(range)
  }, [range])

  return range
}
