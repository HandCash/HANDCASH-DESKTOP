import { useLayoutEffect, type RefObject } from 'react'

export type FitTextOptions = {
  maxPx?: number
  minPx?: number
  /** Re-run when this value changes (e.g. display string). */
  watch?: unknown
}

/**
 * Shrink font-size (then scale) so `contentRef` fits inside `slotRef`
 * without expanding parent layout. Universal for balance rows, titles, tickers.
 */
export function useFitText(
  slotRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
  opts: FitTextOptions = {},
) {
  const maxPx = opts.maxPx ?? 28
  const minPx = opts.minPx ?? 8
  const watch = opts.watch

  useLayoutEffect(() => {
    const slot = slotRef.current
    const content = contentRef.current
    if (!slot || !content) return

    const fit = () => {
      const available = slot.clientWidth
      if (available <= 0) return

      content.style.transform = ''
      content.style.transformOrigin = ''
      content.style.fontSize = `${maxPx}px`

      let size = maxPx
      while (size > minPx && content.scrollWidth > available + 0.5) {
        size -= 0.5
        content.style.fontSize = `${size}px`
      }

      if (content.scrollWidth > available + 0.5) {
        const scale = Math.max(0.35, available / content.scrollWidth)
        content.style.transformOrigin = 'center center'
        content.style.transform = `scale(${scale})`
      }
    }

    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(slot)
    return () => {
      ro.disconnect()
      content.style.fontSize = ''
      content.style.transform = ''
      content.style.transformOrigin = ''
    }
  }, [slotRef, contentRef, maxPx, minPx, watch])
}
