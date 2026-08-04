import { useEffect, type RefObject } from 'react'

export type AnchorPlacement = 'bottom-start' | 'top-start'

export interface AnchorPositionOptions {
  /** Match floating width to anchor (select listboxes). */
  matchWidth?: boolean
}

/** Pin floating surface to trigger rect (for portalled overlays). */
export function useAnchorPosition(
  anchorRef: RefObject<HTMLElement | null>,
  floatingRef: RefObject<HTMLElement | null>,
  active: boolean,
  placement: AnchorPlacement = 'bottom-start',
  options: AnchorPositionOptions = {},
) {
  const { matchWidth = false } = options

  useEffect(() => {
    if (!active || !anchorRef.current || !floatingRef.current) return

    const update = () => {
      const anchor = anchorRef.current
      const floating = floatingRef.current
      if (!anchor || !floating) return

      const rect = anchor.getBoundingClientRect()
      floating.style.position = 'fixed'
      floating.style.left = `${rect.left}px`
      floating.style.bottom = ''
      floating.style.right = ''
      floating.style.zIndex = '50'

      if (matchWidth) {
        floating.style.width = `${rect.width}px`
        floating.style.minWidth = `${rect.width}px`
      } else {
        floating.style.width = ''
        floating.style.minWidth = ''
      }

      if (placement === 'top-start') {
        const height = floating.offsetHeight || floating.getBoundingClientRect().height
        floating.style.top = `${rect.top - height - 4}px`
      } else {
        floating.style.top = `${rect.bottom + 4}px`
      }
    }

    update()
    requestAnimationFrame(update)

    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [active, anchorRef, floatingRef, placement, matchWidth])
}
