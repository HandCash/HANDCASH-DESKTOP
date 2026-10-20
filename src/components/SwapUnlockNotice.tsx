import { useEffect, useState } from 'react'
import { swapUnlockHold } from '../wallet/swap/unlockHold'

const POLL_MS = 30_000

/** While a swap needs this wallet to sign, auto-lock waits: say until when. The lock button beside it still locks at once. */
export function SwapUnlockNotice() {
  const [until, setUntil] = useState<number | null>(() => swapUnlockHold())
  useEffect(() => {
    const id = window.setInterval(() => setUntil(swapUnlockHold()), POLL_MS)
    return () => window.clearInterval(id)
  }, [])
  if (until === null) return null
  const time = new Date(until).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
  return (
    <span className="titlebar-hold" data-aeon-scope="swap-unlock-hold" role="status" title={`A swap needs this wallet to sign. Auto-lock waits until ${time}.`}>
      Swap · unlocked until {time}
    </span>
  )
}
