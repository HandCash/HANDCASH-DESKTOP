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

      // One ratio from the width at maxPx. Stepping half a pixel and reading
      // scrollWidth each time forced layout on every dashboard commit — 264ms
      // of it on a send tap.
      const full = content.scrollWidth
      if (full <= available + 0.5) return
      const fitted = Math.max(minPx, (maxPx * available) / full)
      content.style.fontSize = `${fitted}px`
      const projected = (full * fitted) / maxPx
      if (projected > available + 0.5) {
        const scale = Math.max(0.35, available / projected)
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
