import { assign, setup } from 'xstate'

type MenuError = string | null

export const walletAccountMenuMachine = setup({
  types: {
    context: {} as {
      targetAccountIndex: number | null
      draftName: string
      error: MenuError
    },
    events: {} as
      | { type: 'TOGGLE' }
      | { type: 'CLOSE' }
      | { type: 'CHOOSE'; accountIndex: number }
      | { type: 'SWITCHED' }
      | { type: 'CREATE' }
      | { type: 'CREATED' }
      | { type: 'RENAME'; accountIndex: number; name: string }
      | { type: 'EDIT_NAME'; name: string }
      | { type: 'CANCEL_RENAME' }
      | { type: 'RENAMED' }
      | { type: 'FAIL'; error: string },
  },
}).createMachine({
  id: 'walletAccountMenu',
  initial: 'closed',
  context: {
    targetAccountIndex: null,
    draftName: '',
    error: null,
  },
  states: {
    closed: {
      on: {
        TOGGLE: 'open',
      },
    },
    open: {
      on: {
        TOGGLE: 'closed',
        CLOSE: 'closed',
        CHOOSE: {
          target: 'switching',
          actions: assign({
            targetAccountIndex: ({ event }) => event.accountIndex,
            error: null,
          }),
        },
        CREATE: {
          target: 'creating',
          actions: assign({ error: null }),
        },
        RENAME: {
          target: 'renaming',
          actions: assign({
            targetAccountIndex: ({ event }) => event.accountIndex,
            draftName: ({ event }) => event.name,
            error: null,
          }),
        },
      },
    },
    switching: {
      on: {
        SWITCHED: {
          target: 'closed',
          actions: assign({ targetAccountIndex: null, error: null }),
        },
        FAIL: {
          target: 'open',
          actions: assign({ error: ({ event }) => event.error }),
        },
      },
    },
    creating: {
      on: {
        CREATED: { target: 'closed', actions: assign({ error: null }) },
        FAIL: {
          target: 'open',
          actions: assign({ error: ({ event }) => event.error }),
        },
      },
    },
    renaming: {
      on: {
        EDIT_NAME: {
          actions: assign({ draftName: ({ event }) => event.name }),
        },
        CANCEL_RENAME: {
          target: 'open',
          actions: assign({
            targetAccountIndex: null,
            draftName: '',
            error: null,
          }),
        },
        RENAMED: {
          target: 'open',
          actions: assign({
            targetAccountIndex: null,
            draftName: '',
            error: null,
          }),
        },
        FAIL: {
          target: 'open',
          actions: assign({ error: ({ event }) => event.error }),
        },
      },
    },
  },
})
