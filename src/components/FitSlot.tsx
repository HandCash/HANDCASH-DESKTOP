import { useLayoutEffect, type RefObject } from 'react'

/**
 * Shrinks `contentRef` font-size so full text fits in `slotRef`
 * without expanding parent layout. Scales aggressively when space is tight.
 */
export function useFitFontSize(
  slotRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
  opts: { maxPx?: number; minPx?: number; watch?: unknown } = {},
) {
  const maxPx = opts.maxPx ?? 28
  const minPx = opts.minPx ?? 8

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

      // If still overflowing at min font, scale the whole amount down.
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
  }, [slotRef, contentRef, maxPx, minPx, opts.watch])
}
