import { useMemo, useSyncExternalStore } from 'react'
import { readSwapRecords, subscribeSwapRecords, type SwapRecord } from '../wallet/swap/exolixSwap'
import { readSettleState, settleSnapshot, subscribeSettle } from '../wallet/swap/settleStore'
import { describeSwap, recentSwaps, type SwapRow } from '../wallet/swap/settleView'

export { useHeldCoins } from './heldCoins'

let recordsCache: { json: string; records: SwapRecord[] } = { json: '', records: [] }
function getRecords(): SwapRecord[] {
  const records = readSwapRecords()
  const json = JSON.stringify(records)
  if (json !== recordsCache.json) recordsCache = { json, records }
  return recordsCache.records
}

/** This account's swaps, newest first. */
export function useSwapRecords(): SwapRecord[] {
  return useSyncExternalStore(subscribeSwapRecords, getRecords, getRecords)
}

/** This account's wallet-to-wallet swaps: those still moving, then those finished in the last day. */
export function useDirectSwaps(): SwapRow[] {
  const stored = useSyncExternalStore(subscribeSettle, settleSnapshot, settleSnapshot)
  return useMemo(() => recentSwaps(readSettleState(), Date.now()).map(describeSwap), [stored])
}
