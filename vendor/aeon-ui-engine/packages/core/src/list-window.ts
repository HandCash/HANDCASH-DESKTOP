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
  /**
   * Rows the window moves at a time. The start snaps down to a multiple of it
   * and one extra step mounts below, so a fling re-renders once per step
   * instead of once per row. 1 moves with every row.
   */
  step?: number
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
  const step = Math.max(1, Math.floor(input.step ?? 1))
  const rows = Math.ceil(total / columns)
  const leadRow = Math.max(0, Math.floor(Math.max(0, input.scrolledPast) / rowExtent) - overscan)
  const firstRow = Math.floor(leadRow / step) * step
  const visibleRows =
    Math.ceil(Math.max(0, input.viewportHeight) / rowExtent) + overscan * 2 + (step > 1 ? step : 0)
  const startRow = Math.min(firstRow, Math.max(0, rows - visibleRows))
  const endRow = Math.min(rows, startRow + visibleRows)
  return {
    start: startRow * columns,
    end: Math.min(total, endRow * columns),
    padStart: startRow * rowExtent,
    padEnd: Math.max(0, (rows - endRow) * rowExtent),
  }
}

export interface VariableListWindowInput {
  total: number
  /** Pitch measured per item, gap included; items not measured yet use the estimate. */
  extents: ReadonlyArray<number | undefined>
  /** Pitch for items not measured yet. */
  estimate: number
  overscan?: number
  /** How far the list's content has moved past the first windowed item. */
  scrolledPast: number
  viewportHeight: number
  minItems?: number
  /** Rows the window moves at a time; both edges snap to multiples of it. */
  step?: number
}

/**
 * Window for a one-column list whose rows differ in height. Spacers sum each
 * row's own measured pitch, so moving the window never resizes the content
 * above the viewport. One shared pitch read from whichever row came first did:
 * a tall first row pulled the window back, a short one pushed it on, and the
 * scroll position chased the spacers.
 */
export function computeVariableListWindow(input: VariableListWindowInput): ListWindow {
  const total = Math.max(0, Math.floor(input.total))
  const minItems = input.minItems ?? LIST_WINDOW_MIN_ITEMS
  const estimate = input.estimate
  if (total < minItems || !(estimate > 0)) return fullListWindow(total)
  const overscan = Math.max(0, Math.floor(input.overscan ?? 8))
  const step = Math.max(1, Math.floor(input.step ?? 1))
  const pitch = (i: number) => {
    const extent = input.extents[i]
    return extent !== undefined && extent > 0 ? extent : estimate
  }
  const top = Math.max(0, input.scrolledPast)
  let offset = 0
  let i = 0
  for (; i < total; i++) {
    const next = offset + pitch(i)
    if (next > top) break
    offset = next
  }
  const lead = Math.min(i, total - 1)
  // Counted from the lead row's top, so scrolling within a row keeps the same end.
  const bottom = offset + Math.max(0, input.viewportHeight)
  for (; i < total; i++) {
    offset += pitch(i)
    if (offset >= bottom) break
  }
  const last = Math.min(i, total - 1)
  const start = Math.floor(Math.max(0, lead - overscan) / step) * step
  const end = Math.min(total, Math.ceil((last + 1 + overscan) / step) * step)
  let padStart = 0
  for (let k = 0; k < start; k++) padStart += pitch(k)
  let padEnd = 0
  for (let k = end; k < total; k++) padEnd += pitch(k)
  return { start, end, padStart, padEnd }
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
