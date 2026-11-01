import {
  getTextOverflowSnapshot,
  measureTextOverflow,
  type TextOverflowMode,
  type TextOverflowState,
} from '@aeon-ui/core'
import { useLayoutEffect, useState, type RefObject } from 'react'

export function useTextOverflowState(
  viewportRef: RefObject<HTMLElement | null>,
  trackRef: RefObject<HTMLElement | null>,
  mode: TextOverflowMode,
  paused: boolean,
  watch?: unknown,
): TextOverflowState {
  const [state, setState] = useState<TextOverflowState>('fits')

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const track = trackRef.current
    if (!viewport || !track) return

    const update = () => {
      const overflowing = measureTextOverflow(viewport, track)
      setState(
        getTextOverflowSnapshot({ mode, overflowing, paused }).state,
      )
    }

    update()
    const ro = new ResizeObserver(update)
    ro.observe(viewport)
    ro.observe(track)
    return () => ro.disconnect()
  }, [viewportRef, trackRef, mode, paused, watch])

  return state
}
