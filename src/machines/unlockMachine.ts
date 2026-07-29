import { setup, assign } from 'xstate'

export type UnlockContext = {
  password: string
  error: string | null
}

/**
 * Chart: unlockForm
 * States: idle → submitting → success | failure
 */
export const unlockMachine = setup({
  types: {
    context: {} as UnlockContext,
    events: {} as
      | { type: 'CHANGE'; password: string }
      | { type: 'SUBMIT' }
      | { type: 'SUCCESS' }
      | { type: 'FAIL'; error: string }
      | { type: 'RETRY' },
  },
}).createMachine({
  id: 'unlockForm',
  initial: 'idle',
  context: { password: '', error: null },
  states: {
    idle: {
      on: {
        CHANGE: {
          actions: assign({
            password: ({ event }) => event.password,
            error: null,
          }),
        },
        SUBMIT: {
          guard: ({ context }) => context.password.length >= 8,
          target: 'submitting',
        },
      },
    },
    submitting: {
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
        CHANGE: {
          target: 'idle',
          actions: assign({
            password: ({ event }) => event.password,
            error: null,
          }),
        },
      },
    },
  },
})
