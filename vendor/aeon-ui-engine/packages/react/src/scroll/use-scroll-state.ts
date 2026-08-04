import { getScrollSnapshot } from '@aeon-ui/core'
import { useLayoutEffect, useState, type RefObject } from 'react'

/** Subscribe to scroll + resize; returns data-aeon-state value for a viewport. */
export function useScrollState(ref: RefObject<HTMLElement | null>): string {
  const [stateAttr, setStateAttr] = useState('idle')

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return

    const update = () => {
      setStateAttr(getScrollSnapshot(el).stateAttr)
    }

    update()
    el.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    const content = el.firstElementChild
    if (content instanceof HTMLElement) ro.observe(content)

    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
    }
  }, [ref])

  return stateAttr
}
