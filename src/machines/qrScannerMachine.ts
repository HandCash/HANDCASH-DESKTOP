import { assign, setup } from 'xstate'

export type QrScannerContext = {
  error: string | null
  session: number
}

/**
 * Camera lifecycle. The media stream and decoder are imperative resources, but
 * their visible state is projected from this chart.
 */
export const qrScannerMachine = setup({
  types: {
    context: {} as QrScannerContext,
    events: {} as
      | { type: 'CAMERA_READY' }
      | { type: 'FAIL'; error: string }
      | { type: 'SCANNED' }
      | { type: 'PAUSE' }
      | { type: 'RESUME' },
  },
}).createMachine({
  id: 'qrScanner',
  initial: 'loading',
  context: { error: null, session: 0 },
  states: {
    loading: {
      on: {
        CAMERA_READY: 'ready',
        FAIL: {
          target: 'error',
          actions: assign({ error: ({ event }) => event.error }),
        },
        SCANNED: 'done',
        PAUSE: 'paused',
      },
    },
    ready: {
      on: {
        FAIL: {
          target: 'error',
          actions: assign({ error: ({ event }) => event.error }),
        },
        SCANNED: 'done',
        PAUSE: 'paused',
      },
    },
    paused: {
      on: {
        RESUME: {
          target: 'loading',
          actions: assign({
            error: null,
            session: ({ context }) => context.session + 1,
          }),
        },
        SCANNED: 'done',
      },
    },
    error: {},
    done: { type: 'final' },
  },
})
