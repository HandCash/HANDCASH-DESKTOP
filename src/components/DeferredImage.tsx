import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ImgHTMLAttributes,
  type ReactNode,
} from 'react'
import { Skeleton } from './Skeleton'
import { acquireImageLoadSlot, releaseImageLoadSlot } from './imageLoadSlots'

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
  /**
   * After a successful decode, keep `src` attached for the life of this mount.
   * Activity list thumbs use this — releasing on scroll cleared `src` while
   * status stayed `ready`, which paints an empty `<img>` square for a few frames.
   * Large inventory grids should leave this off so far-away bitmaps free memory.
   */
  retainDecoded?: boolean
}

function markFromElement(img: HTMLImageElement): 'ready' | 'error' | 'loading' {
  if (!img.complete) return 'loading'
  if (img.naturalWidth > 0) return 'ready'
  return 'error'
}

/** Load ~one viewport ahead so the next rows paint decoded, not as skeletons. */
const LOAD_MARGIN_PX = 900
/**
 * Release well behind it. The gap between the two is hysteresis: without it,
 * a frame parked on the boundary would load and unload on every scroll tick.
 */
const RELEASE_MARGIN_PX = 2200

function frameIsNear(frame: HTMLElement, margin = LOAD_MARGIN_PX): boolean {
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
 * Decoded bitmaps live in native memory, not the JS heap, and ordinals are
 * served at full resolution — a 2000px square costs ~16MB decoded. Android kills
 * the WebView for that with no JS error and no heap warning, so the count of
 * live images is worth having in the log when a crash is being chased.
 */
const LIVE_IMAGE_WARN = 16
/** How long one image may occupy a decode slot before the queue moves on. */
const SLOT_STUCK_MS = 10_000
/** Hang ≠ error: GorillaPool can spin forever; fail to fallback after this. */
const LOAD_TIMEOUT_MS = 5_000
let liveImages = 0
let warnedLive = false

/**
 * URLs that have decoded successfully in this session.
 *
 * Deferral costs a skeleton frame: the img gets no `src` until its frame is near
 * the viewport and a decode slot comes back from a promise. That is the right
 * trade for a first paint, but it also means re-mounting over an image the
 * browser already holds — switching to Activity, reopening a panel — blinks a
 * skeleton for a frame or two. The blink reads as the top row flashing, because
 * rows painting a bundled asset have nothing to re-fetch while a remote ordinal
 * thumbnail does. A URL known to have decoded is served straight from cache, so
 * it can be painted without the ceremony.
 */
const decodedOnce = new Set<string>()

function noteImageLive(delta: 1 | -1): void {
  liveImages += delta
  if (liveImages > LIVE_IMAGE_WARN && !warnedLive) {
    warnedLive = true
    console.warn(`[images] ${liveImages} decoded images held at once`)
  }
  if (liveImages <= LIVE_IMAGE_WARN / 2) warnedLive = false
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
  retainDecoded = false,
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
  const cached = typeof src === 'string' && src !== '' && decodedOnce.has(src)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(
    cached ? 'ready' : 'loading',
  )
  const readySent = useRef(false)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const frameRef = useRef<HTMLSpanElement | null>(null)
  /**
   * Hand the img a `src` only once its frame is near the viewport. Ordinals are
   * full-size; fetching a whole grid at once stalls a phone. Deferral is driven
   * by the frame (which has layout via the skeleton), not the hidden img.
   */
  const [near, setNear] = useState(
    () => cached || typeof IntersectionObserver === 'undefined',
  )
  const [loadSlot, setLoadSlot] = useState(cached)
  const slotHeld = useRef(false)
  /** Once painted with retainDecoded, never drop src on this mount. */
  const retained = useRef(retainDecoded && cached)

  useEffect(() => {
    const hit = typeof src === 'string' && src !== '' && decodedOnce.has(src)
    setStatus(hit ? 'ready' : 'loading')
    readySent.current = false
    retained.current = retainDecoded && hit
  }, [src, retainDecoded])

  // Observers are set up once per frame, never per `near` flip: re-observing
  // re-fires the initial callback, which is how an element sitting on a boundary
  // turns into a load/release loop.
  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return

    let cancelled = false
    const mark = (value: boolean) => {
      if (!cancelled) setNear(value)
    }

    // Android WebViews often never fire IntersectionObserver for elements that
    // were already on screen when observe() ran. Check first, then observe.
    if (frameIsNear(frame)) mark(true)

    if (typeof IntersectionObserver === 'undefined') {
      // No observer support — stagger so a grid does not decode everything at once.
      const fallbackTimer = window.setTimeout(() => mark(true), 1_200)
      return () => {
        cancelled = true
        window.clearTimeout(fallbackTimer)
      }
    }

    const loadObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) mark(true)
      },
      { rootMargin: `${LOAD_MARGIN_PX}px` },
    )
    // Dropping src frees the decoded bitmap; scrolling back re-fetches from cache.
    const releaseObserver = new IntersectionObserver(
      (entries) => {
        // `[hidden]` / `display:none` collapses the frame to a 0×0 rect and
        // reports not-intersecting. That is a keep-alive tab, not a scroll-away
        // — releasing here is what made Activity's top thumbnail blink every
        // time the tab was re-shown.
        if (
          entries.every((e) => {
            const r = e.boundingClientRect
            return r.width <= 0 && r.height <= 0
          })
        ) {
          return
        }
        // List thumbs keep the bitmap once shown; releasing them is what
        // flashed empty squares while scrolling Activity.
        if (
          retainDecoded &&
          typeof src === 'string' &&
          src !== '' &&
          (retained.current || decodedOnce.has(src))
        ) {
          return
        }
        if (entries.every((e) => !e.isIntersecting)) mark(false)
      },
      { rootMargin: `${RELEASE_MARGIN_PX}px` },
    )
    loadObserver.observe(frame)
    releaseObserver.observe(frame)

    // Long safety net only. A short timeout used to force-decode every card in
    // a grid ~350ms after mount and freeze Android WebViews.
    const fallbackTimer = window.setTimeout(() => mark(true), 8_000)

    return () => {
      cancelled = true
      window.clearTimeout(fallbackTimer)
      loadObserver.disconnect()
      releaseObserver.disconnect()
    }
  }, [src, retainDecoded])

  const releaseSlotIfHeld = useCallback(() => {
    if (!slotHeld.current) return
    slotHeld.current = false
    releaseImageLoadSlot()
  }, [])

  useEffect(() => {
    if (retained.current) {
      setLoadSlot(true)
      return
    }
    if (!near) {
      setLoadSlot(false)
      return
    }
    // Already decoded once: it is coming from cache, so it neither needs nor
    // should occupy a slot in the decode queue ahead of images that do.
    if (typeof src === 'string' && decodedOnce.has(src)) {
      setLoadSlot(true)
      return
    }
    let cancelled = false
    let stuckTimer: number | undefined
    void acquireImageLoadSlot().then(() => {
      if (cancelled) {
        releaseImageLoadSlot()
        return
      }
      slotHeld.current = true
      setLoadSlot(true)
      // A host that never answers must not hold the queue shut behind it. The
      // request carries on; it just stops counting against the cap.
      stuckTimer = window.setTimeout(releaseSlotIfHeld, SLOT_STUCK_MS)
    })
    return () => {
      cancelled = true
      if (stuckTimer !== undefined) window.clearTimeout(stuckTimer)
      releaseSlotIfHeld()
    }
  }, [near, src, releaseSlotIfHeld])

  // The slot caps concurrent decodes, so it goes back as soon as this image
  // settles. `loadSlot` stays true — the src must remain attached to keep the
  // decoded frame painted; it is dropped only when the frame scrolls far away.
  useEffect(() => {
    if (status === 'ready' || status === 'error') releaseSlotIfHeld()
  }, [status, releaseSlotIfHeld])

  // Hanging content hosts never fire onError — force fallback so Activity
  // thumbs do not skeleton forever.
  useEffect(() => {
    if (status !== 'loading') return
    if (!src) return
    const attached = retained.current || (near && loadSlot)
    if (!attached) return
    const timer = window.setTimeout(() => {
      if (typeof src === 'string') decodedOnce.delete(src)
      retained.current = false
      setStatus('error')
    }, LOAD_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [status, src, near, loadSlot])

  useEffect(() => {
    if (near && loadSlot) return
    if (retained.current) return
    // A URL that already decoded this session must not blink a skeleton when
    // its frame briefly loses a slot (tab hide, slot churn). Keep it ready —
    // but only while src stays attached (see attachSrc). If we clear src, the
    // paint path must not leave a ready+empty img on screen.
    if (typeof src === 'string' && src !== '' && decodedOnce.has(src)) return
    setStatus('loading')
  }, [near, loadSlot, src])

  useEffect(() => {
    if (status !== 'ready') return
    if (retainDecoded) retained.current = true
    noteImageLive(1)
    return () => noteImageLive(-1)
  }, [status, retainDecoded])

  useEffect(() => {
    if (!src || !near || !loadSlot) return
    const img = imgRef.current
    if (!img) return
    const next = markFromElement(img)
    if (next !== 'loading') setStatus(next)
  }, [src, near, loadSlot])

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

  // Never paint an <img> without src. Clearing src while status stayed `ready`
  // (scroll release + decodedOnce short-circuit) was the empty Activity square.
  const attachSrc = retained.current || (near && loadSlot)
  const showImg = status === 'ready' && attachSrc
  const showSkeleton =
    !showImg &&
    !(status === 'error' && (revealOnError || fallback))

  return (
    <span className="deferred-image" data-aeon-state={status} ref={frameRef}>
      {showSkeleton ? (
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
        src={attachSrc ? src : undefined}
        alt={alt}
        width={width}
        height={height}
        loading="eager"
        decoding="async"
        hidden={!showImg}
        onLoad={() => {
          if (typeof src === 'string' && src !== '') decodedOnce.add(src)
          if (retainDecoded) retained.current = true
          setStatus('ready')
        }}
        onError={() => {
          if (typeof src === 'string') decodedOnce.delete(src)
          retained.current = false
          setStatus('error')
        }}
      />
    </span>
  )
}
