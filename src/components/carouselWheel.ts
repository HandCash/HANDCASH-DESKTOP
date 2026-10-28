const STEP_PX = 24
const GESTURE_GAP_MS = 180
/** Finger/mouse travel before a horizontal drag counts as a flick (one slide). */
const FLICK_PX = 40
/** Movement before we commit to horizontal vs vertical. */
const AXIS_PX = 6

type ScrollTrack = Pick<
  HTMLElement,
  | 'clientWidth'
  | 'scrollLeft'
  | 'scrollTo'
  | 'addEventListener'
  | 'removeEventListener'
  | 'setPointerCapture'
  | 'releasePointerCapture'
>

/**
 * Make a horizontal snap track move exactly one slide per wheel or trackpad
 * gesture, however hard it's flicked. A gesture's momentum events keep
 * arriving until it ends, and are spent. Returns the detach function.
 */
export function stepOnWheel(track: ScrollTrack, slides: number): () => void {
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

/**
 * Same one-slide rule for click-drag / touch flick. Owns the horizontal axis
 * (`touch-action: pan-y` on the track); a short tap is left alone so the slide
 * can open the coin list. `onFlick` runs when a slide actually moved, so the
 * following click can be ignored.
 *
 * Capture / preventDefault arm only past {@link FLICK_PX} so jittery taps still
 * deliver click to the coin trigger / compact slide hitbox.
 */
export function stepOnPointer(
  track: ScrollTrack,
  slides: number,
  onFlick?: () => void,
): () => void {
  let pointerId: number | null = null
  let startX = 0
  let startY = 0
  let startIndex = 0
  let axis: 'h' | 'v' | null = null
  let armed = false

  const width = () => track.clientWidth

  const onDown = (e: PointerEvent) => {
    if (pointerId != null) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    // Coin picker, range chip, and links own their clicks — never start a flick.
    if (
      (e.target as Element | null)?.closest?.(
        '.bsv-change, a, [data-aeon-part="coin-trigger"]',
      )
    ) {
      return
    }
    const w = width()
    if (w === 0 || slides < 2) return
    pointerId = e.pointerId
    startX = e.clientX
    startY = e.clientY
    startIndex = Math.round(track.scrollLeft / w)
    axis = null
    armed = false
  }

  const onMove = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return
    const dx = e.clientX - startX
    const dy = e.clientY - startY
    if (axis == null && (Math.abs(dx) > AXIS_PX || Math.abs(dy) > AXIS_PX)) {
      axis = Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v'
      if (axis === 'v') {
        pointerId = null
        return
      }
    }
    if (axis !== 'h') return

    // Below flick threshold: do not capture or preventDefault — keep the tap.
    if (Math.abs(dx) < FLICK_PX) return

    if (!armed) {
      armed = true
      try {
        track.setPointerCapture(e.pointerId)
      } catch {
        /* capture optional */
      }
      globalThis.getSelection?.()?.removeAllRanges()
    }
    e.preventDefault()
    const w = width()
    if (w === 0) return
    track.scrollLeft = startIndex * w - dx
  }

  const onSelectStart = (e: Event) => {
    if (armed) e.preventDefault()
  }

  const finish = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return
    const dx = e.clientX - startX
    const wasArmed = armed
    pointerId = null
    axis = null
    armed = false
    if (!wasArmed) return
    e.preventDefault()
    const w = width()
    if (w === 0) return
    const dir = -Math.sign(dx)
    const aimed = Math.min(slides - 1, Math.max(0, startIndex + dir))
    track.scrollTo({ left: aimed * w, behavior: 'smooth' })
    if (aimed !== startIndex) onFlick?.()
  }

  track.addEventListener('pointerdown', onDown)
  track.addEventListener('pointermove', onMove, { passive: false })
  track.addEventListener('pointerup', finish)
  track.addEventListener('pointercancel', finish)
  track.addEventListener('selectstart', onSelectStart)
  return () => {
    track.removeEventListener('pointerdown', onDown)
    track.removeEventListener('pointermove', onMove)
    track.removeEventListener('pointerup', finish)
    track.removeEventListener('pointercancel', finish)
    track.removeEventListener('selectstart', onSelectStart)
  }
}
