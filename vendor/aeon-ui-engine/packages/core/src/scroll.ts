/** Scroll axis overflow detected on a viewport element. */
export type ScrollOverflow = 'none' | 'x' | 'y' | 'both'

export interface ScrollSnapshot {
  overflow: ScrollOverflow
  /** Space-separated value for data-aeon-state on scroll viewports. */
  stateAttr: string
  atStartY: boolean
  atEndY: boolean
  betweenY: boolean
  atStartX: boolean
  atEndX: boolean
  betweenX: boolean
}

const EPS = 1

function canScrollY(el: HTMLElement): boolean {
  return el.scrollHeight > el.clientHeight + EPS
}

function canScrollX(el: HTMLElement): boolean {
  return el.scrollWidth > el.clientWidth + EPS
}

/** Derive overflow + edge states from a scrollable element. */
export function getScrollSnapshot(el: HTMLElement): ScrollSnapshot {
  const scrollY = canScrollY(el)
  const scrollX = canScrollX(el)

  let overflow: ScrollOverflow = 'none'
  if (scrollY && scrollX) overflow = 'both'
  else if (scrollY) overflow = 'y'
  else if (scrollX) overflow = 'x'

  const atStartY = !scrollY || el.scrollTop <= EPS
  const atEndY = !scrollY || el.scrollTop + el.clientHeight >= el.scrollHeight - EPS
  const betweenY = scrollY && !atStartY && !atEndY

  const atStartX = !scrollX || el.scrollLeft <= EPS
  const atEndX = !scrollX || el.scrollLeft + el.clientWidth >= el.scrollWidth - EPS
  const betweenX = scrollX && !atStartX && !atEndX

  const parts: string[] = []
  if (overflow === 'none') parts.push('idle')
  else parts.push(`overflow-${overflow}`)

  if (scrollY) {
    if (atStartY && atEndY) parts.push('at-start-y', 'at-end-y')
    else if (atStartY) parts.push('at-start-y')
    else if (atEndY) parts.push('at-end-y')
    else parts.push('between-y')
  }

  if (scrollX) {
    if (atStartX && atEndX) parts.push('at-start-x', 'at-end-x')
    else if (atStartX) parts.push('at-start-x')
    else if (atEndX) parts.push('at-end-x')
    else parts.push('between-x')
  }

  return {
    overflow,
    stateAttr: parts.join(' '),
    atStartY,
    atEndY,
    betweenY,
    atStartX,
    atEndX,
    betweenX,
  }
}
