import { useMemo, useSyncExternalStore } from 'react'

/**
 * Read a derived model only when its store generation changes.
 *
 * Store snapshots stay primitive and stable; derived arrays are not rebuilt on
 * unrelated React renders and cannot trigger useSyncExternalStore loops.
 */
export function useExternalGeneration<T>(
  subscribe: (listener: () => void) => () => void,
  getGeneration: () => number,
  derive: () => T,
): T {
  const generation = useSyncExternalStore(subscribe, getGeneration, getGeneration)
  // `derive` is intentionally keyed by the store's generation. Callers provide
  // module functions, not render-local closures.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(derive, [generation])
}
