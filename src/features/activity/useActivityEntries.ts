import { useExternalGeneration } from '../../stores/useExternalGeneration'
import {
  getActivityWriteGeneration,
  listRecentActivity,
  subscribeAppActivity,
  type ActivityEntry,
} from '../../wallet/appActivity'

function subscribe(listener: () => void): () => void {
  return subscribeAppActivity(listener)
}

/** Stable React projection of the activity read model. */
export function useActivityEntries(limit = 500): readonly ActivityEntry[] {
  return useExternalGeneration(
    subscribe,
    getActivityWriteGeneration,
    () => listRecentActivity(limit),
  )
}
