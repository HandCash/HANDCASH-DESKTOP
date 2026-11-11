import { useEffect, useState, type RefObject } from 'react'
import {
  feedIsScrolling,
  forgetFeedScrollRoot,
  noteFeedScroll,
  subscribeFeedScroll,
} from './scrollActivity'
import { resolveScrollRoot } from '@aeon-ui/core'

/**
 * True while the feed is being flung. Image prefetch shrinks until it
 * settles; chain ingest yields its ordinal work for the same window.
 *
 * The flag itself lives in `scrollActivity` — one owner for every feed — so this
 * hook only reports scrolls and re-renders on the transitions.
 */
export function useScrollIdle(ref: RefObject<HTMLElement | null>): boolean {
  const [scrolling, setScrolling] = useState(feedIsScrolling)

  useEffect(() => subscribeFeedScroll(setScrolling), [])
  useReportFeedScroll(ref)

  return scrolling
}

/**
 * Reports the feed's scrolls to `scrollActivity` without re-rendering its
 * caller. A list that does not read the flag must not commit twice per fling.
 */
export function useReportFeedScroll(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const root = resolveScrollRoot(el)
    const marked = root === window ? null : (root as HTMLElement)
    const onScroll = () => noteFeedScroll(marked)
    const target: EventTarget = root === window ? window : root
    target.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      target.removeEventListener('scroll', onScroll)
      forgetFeedScrollRoot(marked)
    }
  }, [ref])
}
