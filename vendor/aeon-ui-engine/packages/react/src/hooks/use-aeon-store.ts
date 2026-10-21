import { useEffect, useRef, useSyncExternalStore } from 'react'
import {
  shallowEqual,
  type AeonStore,
  type AnySlices,
  type EntityOf,
  type QueryOf,
  type QueryResult,
  type StoreEvent,
  type StoreState,
} from '@aeon-ui/primitives'

/**
 * Reads a slice of an Aeon store. Re-renders only when the selected value
 * changes under `equals` (shallow by default), so a component that selects
 * one entity ignores writes to every other.
 */
export function useAeonSelector<S extends AnySlices, T>(
  store: AeonStore<S>,
  selector: (state: StoreState<S>) => T,
  equals: (a: T, b: T) => boolean = shallowEqual,
): T {
  const held = useRef<{ state: StoreState<S>; selector: (state: StoreState<S>) => T; value: T } | null>(null)
  const getSelection = () => {
    const state = store.getSnapshot()
    const last = held.current
    if (last && last.state === state && last.selector === selector) return last.value
    const next = selector(state)
    const value = last && equals(last.value, next) ? last.value : next
    held.current = { state, selector, value }
    return value
  }
  return useSyncExternalStore(store.subscribe, getSelection, getSelection)
}

/** Fetches a query while mounted and returns its result; the entities stay in the store. */
export function useAeonQuery<S extends AnySlices, N extends keyof S & string>(
  store: AeonStore<S>,
  slice: N,
  query: QueryOf<S[N]>,
): QueryResult<EntityOf<S[N]>> {
  const key = typeof query === 'string' ? query : JSON.stringify(query)
  useEffect(() => {
    store.send({ type: 'QUERY.FETCH', slice, query } as StoreEvent<S>)
    // `key` stands for `query`, which callers often rebuild each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, slice, key])
  const read = () => store.query(slice, query)
  return useSyncExternalStore(store.subscribe, read, read)
}
