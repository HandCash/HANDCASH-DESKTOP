import { assign, setup } from 'xstate'

/** Totality for page / list / hub bodies — every state has a slot. */
export const CONTENT_REGION_STATES = [
  'idle',
  'pending',
  'empty',
  'error',
  'ready',
  'loadingMore',
  'success',
] as const

export type ContentRegionState = (typeof CONTENT_REGION_STATES)[number]

export interface ContentRegionContext {
  error: string | null
}

export type ContentRegionEvent =
  | { type: 'LOAD' }
  | { type: 'RESOLVE'; empty?: boolean }
  | { type: 'REJECT'; error: string }
  | { type: 'RETRY' }
  | { type: 'LOAD_MORE' }
  | { type: 'MORE_DONE'; empty?: boolean }
  | { type: 'SUCCEED' }
  | { type: 'RESET' }

/**
 * Content region — status-slotted body under app chrome.
 * Makes async / list / hub totality trivial: pending | empty | error | ready | loadingMore | success.
 * Reference: items-market EmptyPlaceholder + loading skeletons + InfiniteScrollSentinel.
 */
export const contentRegionMachine = setup({
  types: {
    context: {} as ContentRegionContext,
    events: {} as ContentRegionEvent,
    input: {} as Partial<ContentRegionContext>,
  },
  actions: {
    clearError: assign({ error: null }),
    setError: assign({
      error: ({ event }) => (event.type === 'REJECT' ? event.error : null),
    }),
  },
}).createMachine({
  id: 'contentRegion',
  context: ({ input }) => ({
    error: input?.error ?? null,
  }),
  initial: 'idle',
  states: {
    idle: {
      on: {
        LOAD: { target: 'pending', actions: 'clearError' },
        RESET: { actions: 'clearError' },
      },
    },
    pending: {
      on: {
        RESOLVE: [
          { target: 'empty', guard: ({ event }) => Boolean(event.empty) },
          { target: 'ready' },
        ],
        REJECT: { target: 'error', actions: 'setError' },
      },
    },
    empty: {
      on: {
        LOAD: { target: 'pending', actions: 'clearError' },
        RETRY: { target: 'pending', actions: 'clearError' },
        RESET: { target: 'idle', actions: 'clearError' },
      },
    },
    error: {
      on: {
        RETRY: { target: 'pending', actions: 'clearError' },
        LOAD: { target: 'pending', actions: 'clearError' },
        RESET: { target: 'idle', actions: 'clearError' },
      },
    },
    ready: {
      on: {
        LOAD: { target: 'pending', actions: 'clearError' },
        LOAD_MORE: 'loadingMore',
        SUCCEED: 'success',
        RESET: { target: 'idle', actions: 'clearError' },
      },
    },
    loadingMore: {
      on: {
        MORE_DONE: [
          { target: 'ready', guard: ({ event }) => !event.empty },
          { target: 'ready' },
        ],
        REJECT: { target: 'error', actions: 'setError' },
      },
    },
    success: {
      on: {
        LOAD: { target: 'pending', actions: 'clearError' },
        RESET: { target: 'idle', actions: 'clearError' },
      },
    },
  },
})
