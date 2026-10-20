const STEP_PX = 24
const GESTURE_GAP_MS = 180

/**
 * Make a horizontal snap track move exactly one slide per wheel or trackpad
 * gesture, however hard it's flicked. A gesture's momentum events keep
 * arriving until it ends, and are spent. Returns the detach function.
 */
export function stepOnWheel(
  track: Pick<HTMLElement, 'clientWidth' | 'scrollLeft' | 'scrollTo' | 'addEventListener' | 'removeEventListener'>,
  slides: number,
): () => void {
  let travel = 0
  let spent = false
  let aimed: number | null = null
  let gestureEnd: ReturnType<typeof setTimeout> | undefined
  const onWheel = (e: WheelEvent) => {
    const dx = Math.abs(e.deltaX) >= Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0
    if (dx === 0 || track.clientWidth === 0) return
    e.preventDefault()
    clearTimeout(gestureEnd)
    gestureEnd = setTimeout(() => {
      travel = 0
      spent = false
    }, GESTURE_GAP_MS)
    if (spent) return
    travel += dx
    if (Math.abs(travel) < STEP_PX) return
    spent = true
    const at = track.scrollLeft / track.clientWidth
    const from = aimed != null && Math.abs(at - aimed) > 0.01 ? aimed : Math.round(at)
    aimed = Math.min(slides - 1, Math.max(0, from + Math.sign(travel)))
    track.scrollTo({ left: aimed * track.clientWidth, behavior: 'smooth' })
  }
  track.addEventListener('wheel', onWheel, { passive: false })
  return () => {
    track.removeEventListener('wheel', onWheel)
    clearTimeout(gestureEnd)
  }
}
