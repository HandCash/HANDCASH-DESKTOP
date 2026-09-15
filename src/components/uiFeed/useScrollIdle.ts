import { useEffect, useState, type RefObject } from 'react'
import { noteUiScrollActivity } from '../../wallet/walletCoordinator'
import { resolveScrollRoot } from './scrollRoot'

/**
 * True while the feed is being flung. Chunk ramps and image prefetch shrink
 * until it settles; chain ingest yields its ordinal work for the same window.
 */
export function useScrollIdle(
  ref: RefObject<HTMLElement | null>,
  settleMs = 700,
): boolean {
  const [scrolling, setScrolling] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const root = resolveScrollRoot(el)
    const marked = root === window ? null : (root as HTMLElement)
    let timer = 0
    const onScroll = () => {
      noteUiScrollActivity()
      marked?.classList.add('is-scrolling')
      // DeferredImage reads this to shrink its prefetch margin mid-fling.
      document.documentElement.dataset.hcScrolling = '1'
      setScrolling(true)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        marked?.classList.remove('is-scrolling')
        delete document.documentElement.dataset.hcScrolling
        setScrolling(false)
      }, settleMs)
    }
    const target: EventTarget = root === window ? window : root
    target.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      target.removeEventListener('scroll', onScroll)
      window.clearTimeout(timer)
      marked?.classList.remove('is-scrolling')
      delete document.documentElement.dataset.hcScrolling
    }
  }, [ref, settleMs])

  return scrolling
}
