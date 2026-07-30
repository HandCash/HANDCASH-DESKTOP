import { useEffect, useMemo, useRef, useState } from 'react'
import { appFaviconCandidates, appInitials } from '../wallet/appIdentity'
import { SkeletonAvatar } from './Skeleton'

type Props = {
  origin: string
  name: string
  size?: 'sm' | 'md' | 'lg'
  /** Fires once the icon (or initials fallback) is ready to show. */
  onReady?: () => void
}

export function AppAvatar({ origin, name, size = 'md', onReady }: Props) {
  const candidates = useMemo(() => appFaviconCandidates(origin), [origin])
  const [index, setIndex] = useState(0)
  const [failed, setFailed] = useState(candidates.length === 0)
  const [loaded, setLoaded] = useState(false)
  const readySent = useRef(false)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const src = !failed && candidates[index] ? candidates[index] : null
  const ready = failed || loaded

  useEffect(() => {
    setIndex(0)
    setFailed(candidates.length === 0)
    setLoaded(false)
    readySent.current = false
  }, [origin, candidates])

  // Don't hang forever on a silent favicon fetch (offline / stalled CDN).
  useEffect(() => {
    if (ready || !src) return
    const id = window.setTimeout(() => {
      setFailed(true)
    }, 1800)
    return () => window.clearTimeout(id)
  }, [ready, src, index])

  useEffect(() => {
    const img = imgRef.current
    if (!img || !src) return
    if (img.complete && img.naturalWidth > 0) {
      setLoaded(true)
      return
    }
    if (img.complete && img.naturalWidth === 0) {
      // Cached broken image — advance without waiting for another error event.
      if (index + 1 < candidates.length) {
        setIndex((i) => i + 1)
        setLoaded(false)
      } else {
        setFailed(true)
      }
    }
  }, [src, index, candidates.length])

  useEffect(() => {
    if (!ready || readySent.current) return
    readySent.current = true
    onReady?.()
  }, [ready, onReady])

  return (
    <div
      className={`app-avatar app-avatar-${size}`}
      data-aeon-part="avatar"
      data-aeon-state={ready ? (failed ? 'fallback' : 'ready') : 'loading'}
      title={name}
    >
      {!ready ? <SkeletonAvatar size={size} /> : null}
      {src ? (
        <img
          ref={imgRef}
          className={loaded ? 'app-avatar-img is-ready' : 'app-avatar-img'}
          src={src}
          alt=""
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => {
            if (index + 1 < candidates.length) {
              setIndex((i) => i + 1)
              setLoaded(false)
            } else {
              setFailed(true)
            }
          }}
        />
      ) : null}
      {failed ? <span className="app-avatar-fallback">{appInitials(origin)}</span> : null}
    </div>
  )
}
