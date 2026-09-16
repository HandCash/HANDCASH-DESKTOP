/**
 * One owner of "a feed is being flung".
 *
 * Each list used to write `documentElement.dataset.hcScrolling` on its own
 * settle timer, and the wallet coordinator wrote the same flag on a shorter one.
 * Two owners meant the flag cleared while the finger was still moving — image
 * prefetch widened back to a full viewport mid-fling — and unmounting one list
 * cleared it for every other list. Feeds report here; readers ask this module.
 */
import { noteUiScrollActivity } from '../../wallet/walletCoordinator'

/** How long after the last scroll event a feed counts as settled. */
const SETTLE_MS = 700
const SCROLLING_CLASS = 'is-scrolling'

type Listener = (scrolling: boolean) => void

const listeners = new Set<Listener>()
/** Scroll containers currently carrying the class, so only they are cleaned. */
const markedRoots = new Set<HTMLElement>()
let settleTimer = 0
let scrolling = false

function clearMarks(): void {
  for (const root of markedRoots) root.classList.remove(SCROLLING_CLASS)
  markedRoots.clear()
}

function publish(next: boolean): void {
  if (scrolling === next) return
  scrolling = next
  if (typeof document !== 'undefined') {
    if (next) document.documentElement.dataset.hcScrolling = '1'
    else delete document.documentElement.dataset.hcScrolling
  }
  if (!next) clearMarks()
  for (const listener of listeners) listener(next)
}

/** A feed scrolled. Pass its own scroll container, if it has one. */
export function noteFeedScroll(root: HTMLElement | null): void {
  // The wallet side yields background ingest off the same signal.
  noteUiScrollActivity()
  if (root && !markedRoots.has(root)) {
    root.classList.add(SCROLLING_CLASS)
    markedRoots.add(root)
  }
  publish(true)
  if (typeof window === 'undefined') return
  window.clearTimeout(settleTimer)
  settleTimer = window.setTimeout(() => publish(false), SETTLE_MS)
}

/**
 * A feed unmounted. It drops its own class only — the flag belongs to whichever
 * feeds are still moving.
 */
export function forgetFeedScrollRoot(root: HTMLElement | null): void {
  if (!root) return
  root.classList.remove(SCROLLING_CLASS)
  markedRoots.delete(root)
}

export function feedIsScrolling(): boolean {
  return scrolling
}

export function subscribeFeedScroll(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Tests — settle immediately and drop every subscriber. */
export function resetFeedScrollForTests(): void {
  if (typeof window !== 'undefined') window.clearTimeout(settleTimer)
  listeners.clear()
  publish(false)
  clearMarks()
}
