import { useEffect, type RefObject } from 'react'

export type AnchorSide = 'top' | 'bottom'
export type AnchorAlign = 'start' | 'end' | 'center'
export type AnchorPlacement = `${AnchorSide}-${AnchorAlign}`

export interface AnchorPositionOptions {
  /** Match floating width to anchor (select listboxes). */
  matchWidth?: boolean
  /** Gap between anchor and floating surface. */
  gutter?: number
  /** Stack level written to the floating surface. */
  zIndex?: number
  /** Viewport padding kept clear when flipping and clamping. */
  padding?: number
}

const DEFAULT_GUTTER = 4
const DEFAULT_Z_INDEX = 50
const DEFAULT_PADDING = 8

function splitPlacement(placement: AnchorPlacement): [AnchorSide, AnchorAlign] {
  const [side, align] = placement.split('-') as [AnchorSide, AnchorAlign]
  return [side, align]
}

/**
 * Pin floating surface to trigger rect (for portalled overlays).
 *
 * Collision aware: the preferred side flips when it has no room, and the
 * surface is clamped inside the viewport so an end-aligned trigger near an edge
 * never renders offscreen. The resolved geometry is published as
 * `data-side` / `data-align` plus `--aeon-available-height` and
 * `--aeon-anchor-width` so recipes can cap their own scroll area.
 */
export function useAnchorPosition(
  anchorRef: RefObject<HTMLElement | null>,
  floatingRef: RefObject<HTMLElement | null>,
  active: boolean,
  placement: AnchorPlacement = 'bottom-start',
  options: AnchorPositionOptions = {},
) {
  const {
    matchWidth = false,
    gutter = DEFAULT_GUTTER,
    zIndex = DEFAULT_Z_INDEX,
    padding = DEFAULT_PADDING,
  } = options

  useEffect(() => {
    if (!active || !anchorRef.current || !floatingRef.current) return

    let frame = 0

    const update = () => {
      const anchor = anchorRef.current
      const floating = floatingRef.current
      if (!anchor || !floating) return

      const [preferredSide, align] = splitPlacement(placement)
      const rect = anchor.getBoundingClientRect()
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight

      floating.style.position = 'fixed'
      floating.style.bottom = ''
      floating.style.right = ''
      floating.style.zIndex = String(zIndex)

      if (matchWidth) {
        floating.style.width = `${rect.width}px`
        floating.style.minWidth = `${rect.width}px`
      } else {
        floating.style.width = ''
        floating.style.minWidth = ''
      }

      const width = floating.offsetWidth || floating.getBoundingClientRect().width
      const height = floating.offsetHeight || floating.getBoundingClientRect().height

      const roomBelow = viewportHeight - rect.bottom - gutter - padding
      const roomAbove = rect.top - gutter - padding
      const room = preferredSide === 'top' ? roomAbove : roomBelow
      const side =
        room >= height
          ? preferredSide
          : roomAbove > roomBelow
            ? 'top'
            : 'bottom'
      const available = side === 'top' ? roomAbove : roomBelow

      let left = rect.left
      if (align === 'end') left = rect.right - width
      else if (align === 'center') left = rect.left + rect.width / 2 - width / 2

      const maxLeft = Math.max(padding, viewportWidth - width - padding)
      left = Math.min(Math.max(padding, left), maxLeft)

      const top =
        side === 'top'
          ? Math.max(padding, rect.top - gutter - Math.min(height, Math.max(available, 0)))
          : Math.min(
              rect.bottom + gutter,
              Math.max(padding, viewportHeight - height - padding),
            )

      floating.style.left = `${Math.round(left)}px`
      floating.style.top = `${Math.round(top)}px`
      floating.style.setProperty('--aeon-available-height', `${Math.round(Math.max(available, 0))}px`)
      floating.style.setProperty('--aeon-anchor-width', `${Math.round(rect.width)}px`)
      floating.dataset.side = side
      floating.dataset.align = align
    }

    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(update)
    }

    update()
    // Measure again once the surface has laid out (flip/clamp need real height).
    schedule()

    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
    }
  }, [active, anchorRef, floatingRef, placement, matchWidth, gutter, zIndex, padding])
}
