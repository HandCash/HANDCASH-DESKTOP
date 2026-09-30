import { useMemo, useSyncExternalStore } from 'react'
import {
  getActivityWriteGeneration,
  listActivityFeed,
  subscribeAppActivity,
  type ActivityEntry,
} from '../../wallet/appActivity'

function subscribe(listener: () => void): () => void {
  return subscribeAppActivity(listener)
}

/** Stable React projection of the activity read model. */
export function useActivityEntries(limit = 500): readonly ActivityEntry[] {
  const generation = useSyncExternalStore(subscribe, getActivityWriteGeneration, getActivityWriteGeneration)
  return useMemo(() => listActivityFeed(limit), [generation, limit])
}
