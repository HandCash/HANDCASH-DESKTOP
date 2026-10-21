/**
 * Windowed slice of a long list or grid: which items to mount and how much
 * space stands in for the rest. Geometry, not lifecycle, so like Scroll it is
 * a pure function over measurements, never a machine.
 */

export interface ListWindow {
  /** First mounted item index. */
  start: number
  /** One past the last mounted item index. */
  end: number
  /** Pixels standing in for the rows above the window. */
  padStart: number
  /** Pixels standing in for the rows below the window. */
  padEnd: number
}

/** The direction a list scrolls: rows down a column, or items along a strip. */
export type ListWindowAxis = 'y' | 'x'

export interface ListWindowInput {
  total: number
  /** Row pitch in pixels along the scroll axis, gap included. */
  rowExtent: number
  /** Items per row; 1 for a list. */
  columns?: number
  /** Rows mounted beyond each edge of the viewport. */
  overscan?: number
  /** How far the list's content has moved past the start of its viewport. */
  scrolledPast: number
  /** Viewport length along the scroll axis. */
  viewportHeight: number
  /** Below this many items the whole list mounts. */
  minItems?: number
}

/**
 * Below this, windowing costs more than it saves and a mis-measured row would
 * visibly shift a short list.
 */
export const LIST_WINDOW_MIN_ITEMS = 60

export function fullListWindow(total: number): ListWindow {
  return { start: 0, end: Math.max(0, total), padStart: 0, padEnd: 0 }
}

export function sameListWindow(a: ListWindow, b: ListWindow): boolean {
  return a.start === b.start && a.end === b.end && a.padStart === b.padStart && a.padEnd === b.padEnd
}

export function computeListWindow(input: ListWindowInput): ListWindow {
  const total = Math.max(0, Math.floor(input.total))
  const minItems = input.minItems ?? LIST_WINDOW_MIN_ITEMS
  const rowExtent = input.rowExtent
  if (total < minItems || !(rowExtent > 0)) return fullListWindow(total)
  const columns = Math.max(1, Math.floor(input.columns ?? 1))
  const overscan = Math.max(0, Math.floor(input.overscan ?? 8))
  const rows = Math.ceil(total / columns)
  const firstRow = Math.max(0, Math.floor(Math.max(0, input.scrolledPast) / rowExtent) - overscan)
  const visibleRows = Math.ceil(Math.max(0, input.viewportHeight) / rowExtent) + overscan * 2
  const startRow = Math.min(firstRow, Math.max(0, rows - visibleRows))
  const endRow = Math.min(rows, startRow + visibleRows)
  return {
    start: startRow * columns,
    end: Math.min(total, endRow * columns),
    padStart: startRow * rowExtent,
    padEnd: Math.max(0, (rows - endRow) * rowExtent),
  }
}

/** Attribute that marks a spacer, so row measuring skips it. */
export const LIST_WINDOW_PAD_ATTR = 'data-aeon-window-pad'

export function listWindowPadAttrs(edge: 'start' | 'end'): Record<string, string | boolean> {
  return { [LIST_WINDOW_PAD_ATTR]: edge, 'aria-hidden': true }
}

/** The element that actually scrolls a list: the nearest ancestor overflowing on the axis, else the window. */
export function resolveScrollRoot(el: HTMLElement | null, axis: ListWindowAxis = 'y'): HTMLElement | Window {
  let node: HTMLElement | null = el
  while (node) {
    const style = getComputedStyle(node)
    const overflow = axis === 'x' ? style.overflowX : style.overflowY
    if (overflow === 'auto' || overflow === 'scroll') return node
    node = node.parentElement
  }
  return window
}

export function scrollRootHeight(root: HTMLElement | Window): number {
  return root === window ? window.innerHeight : (root as HTMLElement).clientHeight
}

/** Viewport length along the axis. */
export function scrollRootExtent(root: HTMLElement | Window, axis: ListWindowAxis = 'y'): number {
  if (axis === 'y') return scrollRootHeight(root)
  return root === window ? window.innerWidth : (root as HTMLElement).clientWidth
}

export function scrollRootTop(root: HTMLElement | Window): number {
  return root === window ? 0 : (root as HTMLElement).getBoundingClientRect().top
}

/**
 * How far the list's content has moved past the viewport. A list that is its
 * own scroll root reports its scroll offset: subtracting its own edge from
 * itself is always 0, which kept the first rows mounted while the scrollbar
 * travelled through the end spacer.
 */
export function scrollRootScrolledPast(
  root: HTMLElement | Window,
  list: HTMLElement,
  axis: ListWindowAxis = 'y',
): number {
  if (root === list) return axis === 'x' ? list.scrollLeft : list.scrollTop
  if (axis === 'y') return Math.max(0, scrollRootTop(root) - list.getBoundingClientRect().top)
  const rootLeft = root === window ? 0 : (root as HTMLElement).getBoundingClientRect().left
  return Math.max(0, rootLeft - list.getBoundingClientRect().left)
}

/** Real column count for a grid; 1 for a list. The hint is only a fallback. */
export function measureListColumns(style: CSSStyleDeclaration, hint = 1): number {
  if (!style.display.includes('grid')) return 1
  const tracks = style.gridTemplateColumns.trim()
  if (!tracks || tracks === 'none') return Math.max(1, hint)
  return Math.max(1, tracks.split(/\s+/).length)
}

/** Row pitch along the axis from a rendered row, so spacers match what is on screen. */
export function measureListRowExtent(
  list: HTMLElement,
  style: CSSStyleDeclaration,
  hint: number,
  rowSelector?: string,
  axis: ListWindowAxis = 'y',
): number {
  const row = Array.from(list.children).find(
    (node): node is HTMLElement =>
      node instanceof HTMLElement &&
      !node.hasAttribute(LIST_WINDOW_PAD_ATTR) &&
      (!rowSelector || node.matches(rowSelector)),
  )
  if (!row) return hint
  const rect = row.getBoundingClientRect()
  const size = axis === 'x' ? rect.width : rect.height
  if (size <= 0) return hint
  const gap = Number.parseFloat(axis === 'x' ? style.columnGap : style.rowGap)
  return size + (Number.isFinite(gap) ? gap : 0)
}
