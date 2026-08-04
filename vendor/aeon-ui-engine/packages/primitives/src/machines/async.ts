import { assign, setup } from 'xstate'

/** Stable lifecycle states for async data regions (see STATES.md). */
export const ASYNC_LIFECYCLE_STATES = [
  'idle',
  'loading',
  'success',
  'failure',
  'empty',
] as const

export type AsyncLifecycleState = (typeof ASYNC_LIFECYCLE_STATES)[number]

export function isEmptyAsyncData(data: unknown): boolean {
  if (data == null) return true
  if (typeof data === 'string') return data.length === 0
  if (Array.isArray(data)) return data.length === 0
  return false
}

/**
 * Thesis §2.1: fetch lifecycle as sequential, well-defined states.
 * This machine models fetch lifecycle as mutually exclusive states.
 */
export interface AsyncContext<T = unknown> {
  data: T | null
  error: string | null
  /** Success with background refresh — style readout as `success stale` (see STATES.md). */
  stale?: boolean
}

export type AsyncEvent<T = unknown> =
  | { type: 'FETCH' }
  | { type: 'RESOLVE'; data: T }
  | { type: 'REJECT'; error: string }
  | { type: 'RESET' }
  | { type: 'STALE' }
  | { type: 'REFRESH' }

export function createAsyncMachine<T = unknown>() {
  return setup({
    types: {
      context: {} as AsyncContext<T>,
      events: {} as AsyncEvent<T>,
    },
    actions: {
      clear: assign({ data: null, error: null }),
      resolve: assign({
        data: ({ event }) => (event.type === 'RESOLVE' ? event.data : null),
        error: null,
        stale: false,
      }),
      markStale: assign({ stale: true }),
      clearStale: assign({ stale: false }),
      reject: assign({
        error: ({ event }) => (event.type === 'REJECT' ? event.error : null),
        data: null,
      }),
    },
  }).createMachine({
    id: 'async',
    context: { data: null, error: null },
    initial: 'idle',
    states: {
      idle: {
        on: {
          FETCH: 'loading',
          RESET: { actions: 'clear' },
        },
      },
      loading: {
        on: {
          RESOLVE: [
            {
              target: 'empty',
              actions: 'resolve',
              guard: ({ event }) => event.type === 'RESOLVE' && isEmptyAsyncData(event.data),
            },
            { target: 'success', actions: 'resolve' },
          ],
          REJECT: { target: 'failure', actions: 'reject' },
        },
      },
      empty: {
        on: {
          FETCH: 'loading',
          RESET: { target: 'idle', actions: 'clear' },
        },
      },
      success: {
        on: {
          FETCH: { target: 'loading', actions: 'clearStale' },
          STALE: { actions: 'markStale' },
          REFRESH: { actions: 'clearStale' },
          RESET: { target: 'idle', actions: 'clear' },
        },
      },
      failure: {
        on: {
          FETCH: 'loading',
          RESET: { target: 'idle', actions: 'clear' },
        },
      },
    },
  })
}

export const asyncMachine = createAsyncMachine()
