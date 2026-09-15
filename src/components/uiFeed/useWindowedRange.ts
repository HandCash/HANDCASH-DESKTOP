import { useEffect, useState, type RefObject } from 'react'
import { resolveScrollRoot, scrollRootHeight, scrollRootTop } from './scrollRoot'

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

/** Real column count for a grid; 1 for a list. Hints are only a fallback. */
function measureColumns(list: HTMLElement, hint: number): number {
  const style = getComputedStyle(list)
  if (!style.display.includes('grid')) return 1
  const tracks = style.gridTemplateColumns.trim()
  if (!tracks || tracks === 'none') return Math.max(1, hint)
  return Math.max(1, tracks.split(/\s+/).length)
}

/** Row pitch from a rendered child, so padding matches what is on screen. */
function measureRowExtent(
  list: HTMLElement,
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
  const gap = Number.parseFloat(getComputedStyle(list).rowGap)
  return height + (Number.isFinite(gap) ? gap : 0)
}

/**
 * Windowed slice for long lists/grids. Placeholder blocks keep the scroll
 * height so position does not jump; geometry is measured, not assumed.
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
      setRange({ start: 0, end: total, padStart: 0, padEnd: 0 })
      return
    }
    const list = scrollRef.current
    if (!list) return
    const root = resolveScrollRoot(list)

    const measure = () => {
      const columns = measureColumns(list, columnHint)
      const rowExtent = measureRowExtent(list, itemExtent, rowSelector)
      // How far the list has already scrolled past the top of its viewport.
      const scrolledPast = Math.max(
        0,
        scrollRootTop(root) - list.getBoundingClientRect().top,
      )
      const rows = Math.ceil(total / columns)
      const firstRow = Math.max(0, Math.floor(scrolledPast / rowExtent) - overscan)
      const visibleRows =
        Math.ceil(scrollRootHeight(root) / rowExtent) + overscan * 2
      const startRow = Math.min(firstRow, Math.max(0, rows - visibleRows))
      const endRow = Math.min(rows, startRow + visibleRows)
      setRange({
        start: startRow * columns,
        end: Math.min(total, endRow * columns),
        padStart: startRow * rowExtent,
        padEnd: Math.max(0, (rows - endRow) * rowExtent),
      })
    }

    measure()
    const target: EventTarget = root === window ? window : root
    target.addEventListener('scroll', measure, { passive: true })
    window.addEventListener('resize', measure)
    return () => {
      target.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
    }
  }, [total, itemExtent, columnHint, overscan, rowSelector, scrollRef])

  return range
}
