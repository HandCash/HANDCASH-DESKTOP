import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { appFaviconCandidates, appInitials } from '../wallet/appIdentity'
import { SkeletonAvatar } from './Skeleton'

type Props = {
  origin: string
  name: string
  size?: 'sm' | 'md' | 'lg'
  /** Fires once the icon (or initials fallback) is ready to show. */
  onReady?: () => void
}

/** Per-candidate stall budget — advance, don't abandon the whole chain. */
const CANDIDATE_TIMEOUT_MS = 2500
/** After all candidates fail, retry from the top (network may have come up). */
const RETRY_AFTER_MS = 8_000

export function AppAvatar({ origin, name, size = 'md', onReady }: Props) {
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
      setLoaded(true)
      return
    }
    if (img.complete && img.naturalWidth === 0) {
      advanceOrFail()
    }
  }, [src, index, attempt, failed, advanceOrFail])

  // Retry after total failure — favicons often miss on first cold network.
  useEffect(() => {
    if (!failed || candidates.length === 0) return
    const id = window.setTimeout(restart, RETRY_AFTER_MS)
    return () => window.clearTimeout(id)
  }, [failed, candidates.length, attempt, restart])

  // Retry when the app comes back online or the window is focused.
  useEffect(() => {
    if (!failed || candidates.length === 0) return
    window.addEventListener('online', restart)
    window.addEventListener('focus', restart)
    return () => {
      window.removeEventListener('online', restart)
      window.removeEventListener('focus', restart)
    }
  }, [failed, candidates.length, restart])

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
      className={`app-avatar app-avatar-${size}`}
      data-aeon-part="avatar"
      data-aeon-state={ready ? (failed ? 'fallback' : 'ready') : 'loading'}
      title={name}
    >
      {!ready ? <SkeletonAvatar size={size} /> : null}
      {imgSrc ? (
        <img
          key={`${imgSrc}-${attempt}-${index}`}
          ref={imgRef}
          className={loaded ? 'app-avatar-img is-ready' : 'app-avatar-img'}
          src={imgSrc}
          alt=""
          decoding="async"
          referrerPolicy="no-referrer"
          onLoad={() => setLoaded(true)}
          onError={() => {
            advanceOrFail()
          }}
        />
      ) : null}
      {failed ? <span className="app-avatar-fallback">{appInitials(origin)}</span> : null}
    </div>
  )
}
