import { useCallback, useSyncExternalStore } from 'react'
import {
  brc29NoticeDelivery,
  subscribeBrc29NoticeQueue,
  type Brc29NoticeDelivery,
} from '../wallet/pendingBrc29Outbox'

/** The owed BRC-29 notice for `txid`, live with the queue; null when none is owed. */
export function useBrc29NoticeDelivery(txid: string | undefined): Brc29NoticeDelivery | null {
  const read = useCallback(() => (txid ? brc29NoticeDelivery(txid) : null), [txid])
  return useSyncExternalStore(subscribeBrc29NoticeQueue, read)
}
