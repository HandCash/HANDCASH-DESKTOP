import { assign, setup } from 'xstate'

/**
 * Settings → Developer keys: the key list, the new-key step (choose what the
 * key may do), and the fund step for one key's wallet. Work inside a step runs
 * on `useAsyncAction`; this chart only says which step is showing.
 */
export const devKeysPanelMachine = setup({
  types: {
    context: {} as { fundKey: number | null },
    events: {} as
      | { type: 'NEW' }
      | { type: 'FUND'; n: number }
      | { type: 'CANCEL' }
      | { type: 'DONE' },
  },
}).createMachine({
  id: 'devKeysPanel',
  initial: 'list',
  context: { fundKey: null },
  states: {
    list: {
      on: {
        NEW: 'creating',
        FUND: { target: 'funding', actions: assign({ fundKey: ({ event }) => event.n }) },
      },
    },
    creating: {
      on: { CANCEL: 'list', DONE: 'list' },
    },
    funding: {
      on: {
        CANCEL: { target: 'list', actions: assign({ fundKey: null }) },
        DONE: { target: 'list', actions: assign({ fundKey: null }) },
      },
    },
  },
})
