import { useEffect, useState, type RefObject } from 'react'
import {
  feedIsScrolling,
  forgetFeedScrollRoot,
  noteFeedScroll,
  subscribeFeedScroll,
} from './scrollActivity'
import { resolveScrollRoot } from './scrollRoot'

/**
 * True while the feed is being flung. Chunk ramps and image prefetch shrink
 * until it settles; chain ingest yields its ordinal work for the same window.
 *
 * The flag itself lives in `scrollActivity` — one owner for every feed — so this
 * hook only reports scrolls and re-renders on the transitions.
 */
export function useScrollIdle(ref: RefObject<HTMLElement | null>): boolean {
  const [scrolling, setScrolling] = useState(feedIsScrolling)

  useEffect(() => subscribeFeedScroll(setScrolling), [])

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

  return scrolling
}
