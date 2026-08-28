import { useEffect, useMemo, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { splitQrFrames } from '../wallet/qrFrames'
import { SkeletonQr } from './Skeleton'

type Props = {
  value: string
  size?: number
  alt?: string
  /** Frames per second. Clamped to 8–12 so the scanner can keep up. */
  fps?: number
}

/**
 * Cycles QR frames of a dense payload. Pair identity codes should stay a
 * single QR — this is for sealed device-key backups.
 *
 * Do not feed the cycle through DeferredImage: swapping `src` 10/s recreates
 * IntersectionObservers and image-decode slots, which keeps the renderer busy
 * even after leaving the backup QR if this stays mounted.
 */
export function AnimatedQr({
  value,
  size = 180,
  alt = 'Animated recovery code',
  fps = 10,
}: Props) {
  const frames = useMemo(() => splitQrFrames(value), [value])
  const [urls, setUrls] = useState<string[]>([])
  const rootRef = useRef<HTMLDivElement | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const countRef = useRef<HTMLParagraphElement | null>(null)
  const indexRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    setUrls([])
    indexRef.current = 0
    void Promise.all(
      frames.map((text) =>
        QRCode.toDataURL(text, {
          width: size,
          margin: 2,
          color: { dark: '#000000', light: '#FFFFFF' },
          errorCorrectionLevel: 'M',
        }),
      ),
    ).then((next) => {
      if (cancelled) return
      // Decode once so the cycle is a src swap, not a re-encode.
      for (const url of next) {
        const preload = new Image()
        preload.src = url
      }
      setUrls(next)
    })
    return () => {
      cancelled = true
    }
  }, [frames, size])

  useEffect(() => {
    if (urls.length === 0) return
    indexRef.current = 0
    const img = imgRef.current
    if (img) img.src = urls[0]!
    const label = countRef.current
    if (label) label.textContent = `1 / ${urls.length}`
    if (urls.length < 2) return

    const hz = Math.min(12, Math.max(8, fps))
    let timer = 0
    let visible = true

    const stop = () => {
      if (!timer) return
      window.clearInterval(timer)
      timer = 0
    }

    const paint = (i: number) => {
      indexRef.current = i
      const url = urls[i]
      const node = imgRef.current
      if (node && url && node.src !== url) node.src = url
      const label = countRef.current
      if (label) label.textContent = `${i + 1} / ${urls.length}`
    }

    const tick = () => {
      paint((indexRef.current + 1) % urls.length)
    }

    const start = () => {
      if (timer || !visible) return
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      timer = window.setInterval(tick, Math.round(1000 / hz))
    }

    const onVis = () => {
      if (document.visibilityState === 'hidden') stop()
      else start()
    }

    document.addEventListener('visibilitychange', onVis)

    let io: IntersectionObserver | null = null
    const root = rootRef.current
    if (root && typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver((entries) => {
        visible = entries.some((e) => e.isIntersecting && e.intersectionRatio > 0)
        if (visible) start()
        else stop()
      })
      io.observe(root)
    }

    start()

    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVis)
      io?.disconnect()
    }
  }, [urls, fps])

  const count = Math.max(frames.length, 1)
  const ready = urls.length > 0

  return (
    <div ref={rootRef} className="animated-qr" data-aeon-part="animated-qr">
      {ready ? (
        <img
          ref={imgRef}
          src={urls[0]}
          alt={alt}
          width={size}
          height={size}
          decoding="async"
        />
      ) : (
        <SkeletonQr size={size} />
      )}
      <p ref={countRef} className="animated-qr-count" aria-live="polite">
        {ready ? `1 / ${urls.length}` : `1 / ${count}`}
      </p>
    </div>
  )
}
