import { useEffect, useMemo, useState } from 'react'
import { appFaviconCandidates, appInitials } from '../wallet/appIdentity'

type Props = {
  origin: string
  name: string
  size?: 'sm' | 'md' | 'lg'
}

export function AppAvatar({ origin, name, size = 'md' }: Props) {
  const candidates = useMemo(() => appFaviconCandidates(origin), [origin])
  const [index, setIndex] = useState(0)
  const [failed, setFailed] = useState(candidates.length === 0)
  const src = !failed && candidates[index] ? candidates[index] : null

  useEffect(() => {
    setIndex(0)
    setFailed(candidates.length === 0)
  }, [origin, candidates])

  return (
    <div className={`app-avatar app-avatar-${size}`} data-aeon-part="avatar" title={name}>
      {src ? (
        <img
          src={src}
          alt=""
          onError={() => {
            if (index + 1 < candidates.length) setIndex((i) => i + 1)
            else setFailed(true)
          }}
        />
      ) : (
        <span className="app-avatar-fallback">{appInitials(origin)}</span>
      )}
    </div>
  )
}
