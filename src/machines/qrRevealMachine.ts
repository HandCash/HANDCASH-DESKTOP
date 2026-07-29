import { setup, assign } from 'xstate'

export type QrPayload = {
  label: string
  value: string
}

/**
 * Chart: qrReveal
 * States: closed → open
 * Events: SHOW, HIDE
 */
export const qrRevealMachine = setup({
  types: {
    context: {} as { payload: QrPayload | null },
    events: {} as { type: 'SHOW'; payload: QrPayload } | { type: 'HIDE' },
  },
}).createMachine({
  id: 'qrReveal',
  initial: 'closed',
  context: { payload: null },
  states: {
    closed: {
      on: {
        SHOW: {
          target: 'open',
          actions: assign({ payload: ({ event }) => event.payload }),
        },
      },
    },
    open: {
      on: {
        HIDE: {
          target: 'closed',
          actions: assign({ payload: null }),
        },
        SHOW: {
          actions: assign({ payload: ({ event }) => event.payload }),
        },
      },
    },
  },
})
