import { useEffect, useRef, useState } from 'react'
import { CheckIcon } from './icons'
import { isItemProven } from '../wallet/provenCache'

type VerifyMarkPhase = 'hidden' | 'busy' | 'done'

/**
 * Tiny corner mark on an item thumbnail: spinner while authenticity work is
 * in flight, then a check only when the tip is actually proven. Busy→idle
 * without a proof (indexer identify, failed walk, remount) stays hidden —
 * otherwise Collect flashes a checkmark on every visit.
 */
export function CollectableVerifyMark({
  verifying,
  outpoint,
}: {
  verifying: boolean
  outpoint?: string | null
}) {
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
    if (outpoint && isItemProven(outpoint)) {
      setPhase('done')
      const hideTimer = window.setTimeout(() => setPhase('hidden'), 1100)
      return () => window.clearTimeout(hideTimer)
    }
    setPhase('hidden')
  }, [verifying, outpoint])

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
