import { useSyncExternalStore } from 'react'
import { subscribeAppActivity } from './activity'
import type { LtcDepositView } from '../wallet/wltc/depositPhase'
import { readLtcDepositViews, subscribeLtcDeposits } from '../wallet/wltc/bridge'

let cached: { key: string; views: LtcDepositView[] } = { key: '[]', views: [] }

function snapshot(): LtcDepositView[] {
  const views = readLtcDepositViews()
  const key = JSON.stringify(views)
  if (key !== cached.key) cached = { key, views }
  return cached.views
}

function subscribe(listener: () => void): () => void {
  const deposits = subscribeLtcDeposits(listener)
  // An account switch changes whose record is read; activity fires on it.
  const activity = subscribeAppActivity(listener)
  return () => {
    deposits()
    activity()
  }
}

/** The open account's wLTC deposits, newest first, re-read whenever the bridge records a change. */
export function useLtcDeposits(): readonly LtcDepositView[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/** The deposit whose wLTC the BSV transaction `bsvTxid` minted, if any. */
export function useLtcDepositByMint(bsvTxid: string | undefined): LtcDepositView | null {
  const views = useLtcDeposits()
  if (!bsvTxid) return null
  return views.find((v) => v.bsvTxid === bsvTxid) ?? null
}
