import { useEffect, useRef, useState, type ImgHTMLAttributes, type ReactNode } from 'react'
import { Skeleton } from './Skeleton'

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, 'onLoad' | 'onError'> & {
  /** Skeleton size while loading. Defaults to width/height props. */
  skeletonWidth?: number | string
  skeletonHeight?: number | string
  skeletonRadius?: number | string
  skeletonClassName?: string
  /** Called once the image has loaded (or failed, if `revealOnError`). */
  onReady?: () => void
  /** Show the broken image / empty frame after error. Default: stay on skeleton and call onReady. */
  revealOnError?: boolean
  fallback?: ReactNode
}

function markFromElement(img: HTMLImageElement): 'ready' | 'error' | 'loading' {
  if (!img.complete) return 'loading'
  if (img.naturalWidth > 0) return 'ready'
  return 'error'
}

function frameIsNear(frame: HTMLElement, margin = 250): boolean {
  const rect = frame.getBoundingClientRect()
  if (rect.width <= 0 && rect.height <= 0) return false
  return (
    rect.bottom >= -margin &&
    rect.top <= (typeof window !== 'undefined' ? window.innerHeight : 0) + margin &&
    rect.right >= -margin &&
    rect.left <= (typeof window !== 'undefined' ? window.innerWidth : 0) + margin
  )
}

/**
 * App-wide rule: never paint an `<img>` until it has loaded.
 * Shows a skeleton in its place, then reveals the image.
 */
export function DeferredImage({
  skeletonWidth,
  skeletonHeight,
  skeletonRadius,
  skeletonClassName = '',
  onReady,
  revealOnError = false,
  fallback = null,
  className = '',
  width,
  height,
  src,
  alt = '',
  // Swallowed: deferral is this component's job. The browser's `loading="lazy"`
  // cannot work here — the img is `display: none` until ready, so it never
  // intersects and would never fetch.
  loading: _ignoredLoading,
  ...rest
}: Props) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const readySent = useRef(false)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const frameRef = useRef<HTMLSpanElement | null>(null)
  /**
   * Hand the img a `src` only once its frame is near the viewport. Ordinals are
   * full-size; fetching a whole grid at once stalls a phone. Deferral is driven
   * by the frame (which has layout via the skeleton), not the hidden img.
   */
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined')

  useEffect(() => {
    setStatus('loading')
    readySent.current = false
  }, [src])

  useEffect(() => {
    if (near) return
    const frame = frameRef.current
    if (!frame) return

    // Android WebViews often never fire IntersectionObserver for elements that
    // were already on screen when observe() ran. Check first, then observe.
    if (frameIsNear(frame)) {
      setNear(true)
      return
    }

    let cancelled = false
    const mark = () => {
      if (!cancelled) setNear(true)
    }

    const observer =
      typeof IntersectionObserver !== 'undefined'
        ? new IntersectionObserver(
            (entries) => {
              if (entries.some((e) => e.isIntersecting)) {
                mark()
                observer?.disconnect()
              }
            },
            { rootMargin: '250px' },
          )
        : null
    observer?.observe(frame)

    // Absolute fallback — a broken observer must never leave images on the skeleton.
    const fallbackTimer = window.setTimeout(mark, 350)

    return () => {
      cancelled = true
      window.clearTimeout(fallbackTimer)
      observer?.disconnect()
    }
  }, [near, src])

  useEffect(() => {
    const img = imgRef.current
    if (!img || !src || !near) return
    const next = markFromElement(img)
    if (next !== 'loading') setStatus(next)
  }, [src, near])

  useEffect(() => {
    if (status === 'loading') return
    if (readySent.current) return
    readySent.current = true
    onReady?.()
  }, [status, onReady])

  const skW = skeletonWidth ?? width ?? '100%'
  const skH = skeletonHeight ?? height ?? '100%'

  if (!src) {
    return (
      <>
        {fallback ?? (
          <Skeleton
            className={skeletonClassName}
            width={skW}
            height={skH}
            radius={skeletonRadius}
          />
        )}
      </>
    )
  }

  return (
    <span className="deferred-image" data-aeon-state={status} ref={frameRef}>
      {status === 'loading' || (status === 'error' && !revealOnError && !fallback) ? (
        <Skeleton
          className={skeletonClassName}
          width={skW}
          height={skH}
          radius={skeletonRadius}
        />
      ) : null}
      {status === 'error' && fallback ? fallback : null}
      <img
        {...rest}
        ref={imgRef}
        className={className}
        src={near ? src : undefined}
        alt={alt}
        width={width}
        height={height}
        loading="eager"
        decoding="async"
        hidden={status !== 'ready'}
        onLoad={() => setStatus('ready')}
        onError={() => setStatus('error')}
      />
    </span>
  )
}
