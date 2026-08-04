import { assign, setup } from 'xstate'

export interface DialogContext {
  open: boolean
}

export type DialogEvent =
  | { type: 'OPEN' }
  | { type: 'CLOSE' }
  | { type: 'TOGGLE' }
  | { type: 'SET_OPEN'; open: boolean }
  | { type: 'ESCAPE' }
  | { type: 'POINTER_DOWN_OUTSIDE' }

/**
 * Dialog visibility is a single orthogonal region: closed | open.
 * Open and closed are distinct, stable states.
 */
export const dialogMachine = setup({
  types: {
    context: {} as DialogContext,
    events: {} as DialogEvent,
    input: {} as DialogContext,
  },
  actions: {
    markOpen: assign({ open: true }),
    markClosed: assign({ open: false }),
    toggleOpen: assign({ open: ({ context }) => !context.open }),
    setOpen: assign({
      open: ({ event }) => (event.type === 'SET_OPEN' ? event.open : false),
    }),
  },
}).createMachine({
  id: 'dialog',
  context: ({ input }) => ({
    open: input.open ?? false,
  }),
  initial: 'closed',
  states: {
    closed: {
      on: {
        OPEN: { target: 'open', actions: 'markOpen' },
        TOGGLE: { target: 'open', actions: 'markOpen' },
        SET_OPEN: [
          { target: 'open', actions: 'markOpen', guard: ({ event }) => event.open },
        ],
      },
    },
    open: {
      on: {
        CLOSE: { target: 'closed', actions: 'markClosed' },
        ESCAPE: { target: 'closed', actions: 'markClosed' },
        POINTER_DOWN_OUTSIDE: { target: 'closed', actions: 'markClosed' },
        TOGGLE: { target: 'closed', actions: 'markClosed' },
        SET_OPEN: [
          { target: 'closed', actions: 'markClosed', guard: ({ event }) => !event.open },
        ],
      },
    },
  },
})
