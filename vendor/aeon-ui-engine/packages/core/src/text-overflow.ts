/** How overflowing text is shown inside a constrained slot. */
export type TextOverflowMode = 'truncate' | 'carousel'

/**
 * Derived layout state for TextOverflow (Scroll pattern — no XState machine).
 * - fits: label fits the viewport; no overflow treatment
 * - truncate: overflowing + truncate mode (ellipsis)
 * - carousel: overflowing + carousel mode (marquee)
 * - paused: carousel paused (hover / focus / reduced motion)
 */
export type TextOverflowState = 'fits' | 'truncate' | 'carousel' | 'paused'

export type TextOverflowSnapshot = {
  mode: TextOverflowMode
  overflowing: boolean
  paused: boolean
  state: TextOverflowState
  stateAttr: string
}

const EPS = 1

export function resolveTextOverflowState(input: {
  mode: TextOverflowMode
  overflowing: boolean
  paused?: boolean
}): TextOverflowState {
  if (!input.overflowing) return 'fits'
  if (input.mode === 'truncate') return 'truncate'
  if (input.paused) return 'paused'
  return 'carousel'
}

/**
 * Measure whether the first track item is wider than `viewport`.
 * Uses the first child so a duplicated carousel copy does not inflate width.
 */
export function measureTextOverflow(
  viewport: HTMLElement,
  track: HTMLElement,
): boolean {
  const first = track.firstElementChild
  const width =
    first instanceof HTMLElement ? first.scrollWidth : track.scrollWidth
  return width > viewport.clientWidth + EPS
}

export function getTextOverflowSnapshot(input: {
  mode: TextOverflowMode
  overflowing: boolean
  paused?: boolean
}): TextOverflowSnapshot {
  const paused = Boolean(input.paused)
  const state = resolveTextOverflowState({
    mode: input.mode,
    overflowing: input.overflowing,
    paused,
  })
  return {
    mode: input.mode,
    overflowing: input.overflowing,
    paused,
    state,
    stateAttr: state,
  }
}
