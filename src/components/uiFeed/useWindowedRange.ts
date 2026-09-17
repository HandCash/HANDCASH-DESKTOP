import { useEffect, useState, type RefObject } from 'react'
import {
  resolveScrollRoot,
  scrollRootHeight,
  scrollRootScrolledPast,
} from './scrollRoot'

/**
 * Below this, windowing costs more than it saves and a mis-measured row height
 * would visibly shift a short list. Render those in full.
 */
const MIN_WINDOWED_ITEMS = 60

export type WindowedRange = {
  start: number
  end: number
  padStart: number
  padEnd: number
}

function sameRange(a: WindowedRange, b: WindowedRange): boolean {
  return (
    a.start === b.start &&
    a.end === b.end &&
    a.padStart === b.padStart &&
    a.padEnd === b.padEnd
  )
}

/** Real column count for a grid; 1 for a list. Hints are only a fallback. */
function measureColumns(style: CSSStyleDeclaration, hint: number): number {
  if (!style.display.includes('grid')) return 1
  const tracks = style.gridTemplateColumns.trim()
  if (!tracks || tracks === 'none') return Math.max(1, hint)
  return Math.max(1, tracks.split(/\s+/).length)
}

/** Row pitch from a rendered child, so padding matches what is on screen. */
function measureRowExtent(
  list: HTMLElement,
  style: CSSStyleDeclaration,
  hint: number,
  rowSelector?: string,
): number {
  const child = Array.from(list.children).find(
    (node): node is HTMLElement =>
      node instanceof HTMLElement &&
      !node.dataset.uiFeedPad &&
      (!rowSelector || node.matches(rowSelector)),
  )
  if (!child) return hint
  const height = child.getBoundingClientRect().height
  if (height <= 0) return hint
  const gap = Number.parseFloat(style.rowGap)
  return height + (Number.isFinite(gap) ? gap : 0)
}

/**
 * Windowed slice for long lists/grids. Placeholder blocks keep the scroll
 * height so position does not jump; geometry is measured, not assumed.
 *
 * Measuring reads layout, so it runs at most once per frame and publishes only
 * when the slice actually moves — a scroll event that lands inside the current
 * window must not re-render every row for an identical range.
 */
export function useWindowedRange(args: {
  total: number
  /** Fallback row pitch used only before the first child is measurable. */
  itemExtent: number
  /** Fallback column count for grids. */
  columns?: number
  overscan?: number
  /** Restrict measuring to real rows when the list also holds other chrome. */
  rowSelector?: string
  /** The list element itself — its scrollable ancestor drives the window. */
  scrollRef: RefObject<HTMLElement | null>
}): WindowedRange {
  const {
    total,
    itemExtent,
    columns: columnHint = 1,
    overscan = 8,
    rowSelector,
    scrollRef,
  } = args
  const [range, setRange] = useState<WindowedRange>(() => ({
    start: 0,
    end: total,
    padStart: 0,
    padEnd: 0,
  }))

  useEffect(() => {
    if (total < MIN_WINDOWED_ITEMS) {
      setRange((current) => {
        const full = { start: 0, end: total, padStart: 0, padEnd: 0 }
        return sameRange(current, full) ? current : full
      })
      return
    }
    const list = scrollRef.current
    if (!list) return
    const root = resolveScrollRoot(list)

    let published: WindowedRange | null = null
    let frame = 0
    let cancelled = false

    const measureNow = () => {
      // One style read feeds both the column count and the row pitch.
      const style = getComputedStyle(list)
      const columns = measureColumns(style, columnHint)
      const rowExtent = measureRowExtent(list, style, itemExtent, rowSelector)
      // How far the list has already scrolled past the top of its viewport.
      const scrolledPast = scrollRootScrolledPast(root, list)
      const rows = Math.ceil(total / columns)
      const firstRow = Math.max(0, Math.floor(scrolledPast / rowExtent) - overscan)
      const visibleRows =
        Math.ceil(scrollRootHeight(root) / rowExtent) + overscan * 2
      const startRow = Math.min(firstRow, Math.max(0, rows - visibleRows))
      const endRow = Math.min(rows, startRow + visibleRows)
      const next: WindowedRange = {
        start: startRow * columns,
        end: Math.min(total, endRow * columns),
        padStart: startRow * rowExtent,
        padEnd: Math.max(0, (rows - endRow) * rowExtent),
      }
      if (published && sameRange(published, next)) return
      published = next
      setRange(next)
    }

    // Scroll fires far more often than the window moves; coalesce to a frame so
    // the layout read happens once per paint at most.
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
  }, [total, itemExtent, columnHint, overscan, rowSelector, scrollRef])

  return range
}
