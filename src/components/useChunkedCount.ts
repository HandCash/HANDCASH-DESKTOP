import { useEffect, useState } from 'react'

/**
 * Reveal a long list a chunk at a time so opening a panel does not block paint.
 *
 * Pause while the parent is scrolling so a fling does not fight the ramp.
 */
export function useChunkedCount(
  total: number,
  chunk: number,
  paused = false,
): number {
  const [shown, setShown] = useState(() => Math.min(chunk, total))

  useEffect(() => {
    setShown(Math.min(chunk, total))
  }, [total, chunk])

  useEffect(() => {
    if (paused) return
    if (shown >= total) return

    let cancelled = false
    let frame = 0
    let timer = 0
    const advance = () => {
      if (cancelled) return
      setShown((current) => Math.min(total, current + chunk))
    }
    frame = window.requestAnimationFrame(advance)
    timer = window.setTimeout(advance, 100)
    return () => {
      cancelled = true
      window.cancelAnimationFrame(frame)
      window.clearTimeout(timer)
    }
  }, [shown, total, chunk, paused])

  return Math.min(shown, total)
}
