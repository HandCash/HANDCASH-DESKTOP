import { useSyncExternalStore } from 'react'
import { isLabEnabled, subscribeLabs, type LabFeatureId } from '../wallet/labs'

/** Live value of one Settings → Labs flag. */
export function useLab(id: LabFeatureId): boolean {
  return useSyncExternalStore(subscribeLabs, () => isLabEnabled(id))
}
