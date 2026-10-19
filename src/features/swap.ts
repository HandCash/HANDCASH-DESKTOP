import { useMemo, useSyncExternalStore } from 'react'
import { readSwapRecords, subscribeSwapRecords } from '../wallet/swap/exolixSwap'
import { readSettleState, settleSnapshot, subscribeSettle } from '../wallet/swap/settleStore'
import { recentSwapViews, swapViews, type SwapView } from '../wallet/swap/swapView'

export { useHeldCoins } from './heldCoins'

function subscribeSwaps(listener: () => void): () => void {
  const offSettle = subscribeSettle(listener)
  const offExolix = subscribeSwapRecords(listener)
  return () => {
    offSettle()
    offExolix()
  }
}

let viewsCache: { key: string; views: SwapView[] } = { key: '', views: [] }

/** Both swap stores as one string, stable between writes. */
function swapsSnapshot(): string {
  return `${settleSnapshot()}\u0000${JSON.stringify(readSwapRecords())}`
}

function viewsOf(key: string): SwapView[] {
  if (key !== viewsCache.key) viewsCache = { key, views: swapViews(readSettleState(), readSwapRecords()) }
  return viewsCache.views
}

/** Every swap of this account, either route, moving ones first. */
export function useSwapViews(): SwapView[] {
  const key = useSyncExternalStore(subscribeSwaps, swapsSnapshot, swapsSnapshot)
  return viewsOf(key)
}

/** Swaps still moving, then those finished in the last day. */
export function useRecentSwaps(route?: SwapView['route']): SwapView[] {
  const views = useSwapViews()
  return useMemo(() => recentSwapViews(route ? views.filter((v) => v.route === route) : views, Date.now()), [views, route])
}
