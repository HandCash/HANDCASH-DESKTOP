import { setup, assign } from 'xstate'

export type WipeContext = {
  password: string
  confirmText: string
  acknowledged: boolean
  error: string | null
}

/**
 * Chart: wipeWallet
 * States: idle → confirming → wiping → success | failure
 */
export const wipeMachine = setup({
  types: {
    context: {} as WipeContext,
    events: {} as
      | { type: 'CHANGE_PASSWORD'; password: string }
      | { type: 'CHANGE_CONFIRM'; confirmText: string }
      | { type: 'TOGGLE_ACK'; acknowledged: boolean }
      | { type: 'SUBMIT' }
      | { type: 'SUCCESS' }
      | { type: 'FAIL'; error: string }
      | { type: 'RETRY' },
  },
}).createMachine({
  id: 'wipeWallet',
  initial: 'idle',
  context: {
    password: '',
    confirmText: '',
    acknowledged: false,
    error: null,
  },
  states: {
    idle: {
      on: {
        CHANGE_PASSWORD: {
          actions: assign({
            password: ({ event }) => event.password,
            error: null,
          }),
        },
        CHANGE_CONFIRM: {
          actions: assign({
            confirmText: ({ event }) => event.confirmText,
            error: null,
          }),
        },
        TOGGLE_ACK: {
          actions: assign({
            acknowledged: ({ event }) => event.acknowledged,
            error: null,
          }),
        },
        SUBMIT: {
          guard: ({ context }) =>
            context.password.length >= 8 &&
            context.acknowledged &&
            context.confirmText.trim().toUpperCase() === 'DELETE',
          target: 'wiping',
        },
      },
    },
    wiping: {
      on: {
        SUCCESS: 'success',
        FAIL: {
          target: 'failure',
          actions: assign({ error: ({ event }) => event.error }),
        },
      },
    },
    success: { type: 'final' },
    failure: {
      on: {
        RETRY: {
          target: 'idle',
          actions: assign({ error: null }),
        },
        CHANGE_PASSWORD: {
          target: 'idle',
          actions: assign({
            password: ({ event }) => event.password,
            error: null,
          }),
        },
        CHANGE_CONFIRM: {
          target: 'idle',
          actions: assign({
            confirmText: ({ event }) => event.confirmText,
            error: null,
          }),
        },
        TOGGLE_ACK: {
          target: 'idle',
          actions: assign({
            acknowledged: ({ event }) => event.acknowledged,
            error: null,
          }),
        },
      },
    },
  },
})
