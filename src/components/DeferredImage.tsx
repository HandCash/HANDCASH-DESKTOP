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
  // Deliberately swallowed: this component hides the img until it loads, and a
  // `display: none` img never satisfies lazy loading's intersection check — it
  // would never fetch, never fire onLoad, and sit on the skeleton forever.
  loading: _ignoredLoading,
  ...rest
}: Props) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const readySent = useRef(false)
  const imgRef = useRef<HTMLImageElement | null>(null)

  useEffect(() => {
    setStatus('loading')
    readySent.current = false
  }, [src])

  useEffect(() => {
    const img = imgRef.current
    if (!img || !src) return
    const next = markFromElement(img)
    if (next !== 'loading') setStatus(next)
  }, [src])

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
    <span className="deferred-image" data-aeon-state={status}>
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
        src={src}
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
