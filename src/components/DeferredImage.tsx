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
  // Deliberately swallowed. Deferral is this component's job (see `near` below);
  // the browser's own lazy loading cannot do it here, because the img is hidden
  // until it loads and a `display: none` element never intersects — it would
  // never fetch, never fire onLoad, and sit on the skeleton forever.
  loading: _ignoredLoading,
  ...rest
}: Props) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const readySent = useRef(false)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const frameRef = useRef<HTMLSpanElement | null>(null)
  /**
   * Whether this has come near the viewport. Ordinals are full-size images, so a
   * grid of them fetched at once stalls a phone — but the browser's own
   * `loading="lazy"` cannot help while the img is hidden, since a `display: none`
   * element never intersects. The skeleton keeps the frame in layout, so we defer
   * off the frame instead and only then hand the img a `src`.
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
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true)
          observer.disconnect()
        }
      },
      { rootMargin: '250px' },
    )
    observer.observe(frame)
    return () => observer.disconnect()
  }, [near])

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
        // No src until the frame is near the viewport: that, not the `loading`
        // attribute, is what keeps a grid of ordinals from fetching all at once.
        src={near ? src : undefined}
        alt={alt}
        width={width}
        height={height}
        loading="eager"
        hidden={status !== 'ready'}
        onLoad={() => setStatus('ready')}
        onError={() => setStatus('error')}
      />
    </span>
  )
}
