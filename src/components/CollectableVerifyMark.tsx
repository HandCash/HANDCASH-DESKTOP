import { useEffect, useRef, useState } from 'react'
import { CheckIcon } from './icons'

type VerifyMarkPhase = 'hidden' | 'busy' | 'done'

/**
 * Tiny corner mark on an item thumbnail: spinner from receive until authenticity
 * settles, then check, then gone. No idle gap between spinner and check.
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
    const hideTimer = window.setTimeout(() => setPhase('hidden'), 1100)
    return () => window.clearTimeout(hideTimer)
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
