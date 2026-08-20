import { assign, setup } from 'xstate'

export type ModelViewerContext = {
  attempt: number
  error: string | null
}

export type ModelViewerEvent =
  | { type: 'READY' }
  | { type: 'FAIL'; error: string }
  | { type: 'RETRY' }

/**
 * Chart: modelViewer
 * States: loading → ready | failed → loading
 *
 * The model element remains mounted while loading so its network/decode work is
 * not restarted. UI only reveals it after READY; until then the state projects
 * to a same-size skeleton.
 */
export const modelViewerMachine = setup({
  types: {
    context: {} as ModelViewerContext,
    events: {} as ModelViewerEvent,
  },
}).createMachine({
  id: 'modelViewer',
  initial: 'loading',
  context: {
    attempt: 0,
    error: null,
  },
  states: {
    loading: {
      on: {
        READY: 'ready',
        FAIL: {
          target: 'failed',
          actions: assign({ error: ({ event }) => event.error }),
        },
      },
    },
    ready: {},
    failed: {
      on: {
        RETRY: {
          target: 'loading',
          actions: assign({
            attempt: ({ context }) => context.attempt + 1,
            error: null,
          }),
        },
      },
    },
  },
})
