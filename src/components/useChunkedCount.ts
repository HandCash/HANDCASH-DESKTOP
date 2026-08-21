import { useEffect, useState } from 'react'

/**
 * Reveal a long list a chunk at a time so opening a panel does not block paint.
 *
 * The ramp must not depend on `requestAnimationFrame` alone. Chromium stops
 * delivering frames while the window is hidden or occluded, and a long task can
 * starve them for seconds, either of which would leave the list stranded
 * partway with no way to finish. A timer races each frame so the count always
 * reaches `total`.
 */
export function useChunkedCount(total: number, chunk: number): number {
  const [shown, setShown] = useState(() => Math.min(chunk, total))

  useEffect(() => {
    setShown(Math.min(chunk, total))
    if (total <= chunk) return

    let cancelled = false
    let next = chunk
    let frame = 0
    let timer = 0

    const advance = () => {
      if (cancelled) return
      window.cancelAnimationFrame(frame)
      window.clearTimeout(timer)
      next = Math.min(total, next + chunk)
      setShown(next)
      if (next < total) schedule()
    }

    const schedule = () => {
      frame = window.requestAnimationFrame(advance)
      timer = window.setTimeout(advance, 100)
    }

    schedule()
    return () => {
      cancelled = true
      window.cancelAnimationFrame(frame)
      window.clearTimeout(timer)
    }
  }, [total, chunk])

  return shown
}
