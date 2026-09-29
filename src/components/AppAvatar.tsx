import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { appFaviconCandidates, appInitials } from '../wallet/appIdentity'
import { AppsIcon } from './icons'
import { SkeletonAvatar } from './Skeleton'

type Props = {
  origin: string
  name: string
  size?: 'sm' | 'md' | 'lg'
  /** Fill a parent badge — no second ring, border, or skeleton disc. */
  embedded?: boolean
  /** Fires once the icon (or initials fallback) is ready to show. */
  onReady?: () => void
}

/** Per-candidate stall budget — advance, don't abandon the whole chain. */
const CANDIDATE_TIMEOUT_MS = 2500
/** After all candidates fail, retry from the top (network may have come up). */
const RETRY_AFTER_MS = 8_000
/** Tiny legacy favicons look visibly pixelated in app cards and badges. */
const MIN_ICON_EDGE_PX = 24

export function AppAvatar({
  origin,
  name,
  size = 'md',
  embedded = false,
  onReady,
}: Props) {
  const candidates = useMemo(() => appFaviconCandidates(origin), [origin])
  const [index, setIndex] = useState(0)
  const [attempt, setAttempt] = useState(0)
  const [failed, setFailed] = useState(candidates.length === 0)
  const [loaded, setLoaded] = useState(false)
  const readySent = useRef(false)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const candidatesRef = useRef(candidates)
  candidatesRef.current = candidates

  const src = !failed && candidates[index] ? candidates[index] : null
  const ready = failed || loaded
  // The activity subscript is 16px. Favicons of that size are the picture,
  // not a failure — rejecting them made the badge cycle candidates and
  // redraw every few seconds.
  const minEdge = embedded ? 1 : MIN_ICON_EDGE_PX

  const advanceOrFail = useCallback(() => {
    setLoaded(false)
    setIndex((i) => {
      const list = candidatesRef.current
      if (i + 1 < list.length) return i + 1
      setFailed(true)
      return i
    })
  }, [])

  const restart = useCallback(() => {
    setFailed(false)
    setIndex(0)
    setLoaded(false)
    readySent.current = false
    setAttempt((n) => n + 1)
  }, [])

  useEffect(() => {
    setIndex(0)
    setFailed(candidates.length === 0)
    setLoaded(false)
    readySent.current = false
    setAttempt(0)
  }, [origin, candidates])

  // Stall on one URL → try the next candidate (do not permanent-fail the avatar).
  useEffect(() => {
    if (ready || !src || failed) return
    const id = window.setTimeout(() => {
      advanceOrFail()
    }, CANDIDATE_TIMEOUT_MS)
    return () => window.clearTimeout(id)
  }, [ready, src, index, attempt, failed, advanceOrFail])

  // Cached / complete image handling when src changes.
  useEffect(() => {
    const img = imgRef.current
    if (!img || !src || failed) return
    if (img.complete && img.naturalWidth > 0) {
      if (img.naturalWidth < minEdge || img.naturalHeight < minEdge) {
        advanceOrFail()
        return
      }
      setLoaded(true)
      return
    }
    if (img.complete && img.naturalWidth === 0) {
      advanceOrFail()
    }
  }, [src, index, attempt, failed, advanceOrFail, minEdge])

  // Retry after total failure — favicons often miss on first cold network.
  // Not on an embedded subscript: restarting blanks a painted mark and the
  // activity row flickers for as long as the origin has no large favicon.
  useEffect(() => {
    if (embedded || !failed || candidates.length === 0) return
    const id = window.setTimeout(restart, RETRY_AFTER_MS)
    return () => window.clearTimeout(id)
  }, [embedded, failed, candidates.length, attempt, restart])

  // Retry when the app comes back online or the window is focused.
  useEffect(() => {
    if (embedded || !failed || candidates.length === 0) return
    window.addEventListener('online', restart)
    window.addEventListener('focus', restart)
    return () => {
      window.removeEventListener('online', restart)
      window.removeEventListener('focus', restart)
    }
  }, [embedded, failed, candidates.length, restart])

  useEffect(() => {
    if (!ready || readySent.current) return
    readySent.current = true
    onReady?.()
  }, [ready, onReady])

  // Cache-bust only on retries so a broken first response isn't sticky forever.
  const imgSrc =
    src && attempt > 0 ? `${src}${src.includes('?') ? '&' : '?'}_r=${attempt}` : src

  return (
    <div
      className={`app-avatar app-avatar-${size}${embedded ? ' app-avatar-embedded' : ''}`}
      data-aeon-part="avatar"
      data-aeon-state={ready ? (failed ? 'fallback' : 'ready') : 'loading'}
      title={name}
    >
      {!ready && !embedded ? <SkeletonAvatar size={size} /> : null}
      {imgSrc ? (
        <img
          key={`${imgSrc}-${attempt}-${index}`}
          ref={imgRef}
          className={loaded ? 'app-avatar-img is-ready' : 'app-avatar-img'}
          src={imgSrc}
          alt=""
          decoding="async"
          referrerPolicy="no-referrer"
          onLoad={(event) => {
            const image = event.currentTarget
            if (image.naturalWidth < minEdge || image.naturalHeight < minEdge) {
              advanceOrFail()
              return
            }
            setLoaded(true)
          }}
          onError={() => {
            advanceOrFail()
          }}
        />
      ) : null}
      {failed ? (
        <span className="app-avatar-fallback" aria-label={appInitials(origin)}>
          <AppsIcon
            size={embedded ? 8 : size === 'lg' ? 28 : size === 'sm' ? 18 : 22}
          />
        </span>
      ) : null}
    </div>
  )
}
