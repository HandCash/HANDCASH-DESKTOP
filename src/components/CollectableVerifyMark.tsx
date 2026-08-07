import { useEffect, useRef, useState } from 'react'
import { CheckIcon } from './icons'

type VerifyMarkPhase = 'hidden' | 'busy' | 'done'

/**
 * Tiny corner mark on an item thumbnail: spinner while proving, check when
 * done, then gone. Used on Collectables and Activity item rows.
 */
export function CollectableVerifyMark({ verifying }: { verifying: boolean }) {
  const [phase, setPhase] = useState<VerifyMarkPhase>(() =>
    verifying ? 'busy' : 'hidden',
  )
  const wasBusy = useRef(verifying)

  useEffect(() => {
    if (verifying) {
      wasBusy.current = true
      setPhase('busy')
      return
    }
    if (!wasBusy.current) {
      setPhase('hidden')
      return
    }
    wasBusy.current = false
    setPhase('done')
    const t = window.setTimeout(() => setPhase('hidden'), 850)
    return () => window.clearTimeout(t)
  }, [verifying])

  if (phase === 'hidden') return null

  return (
    <span
      className={`collectable-verify-mark collectable-verify-mark--${phase}`}
      aria-live="polite"
      aria-label={phase === 'busy' ? 'Verifying authenticity' : 'Verified'}
      title={phase === 'busy' ? 'Verifying authenticity' : 'Verified'}
    >
      {phase === 'busy' ? (
        <span className="collectable-verify-spinner" aria-hidden />
      ) : (
        <CheckIcon size={10} />
      )}
    </span>
  )
}
