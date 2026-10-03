import { assign, setup } from 'xstate'

type MenuError = string | null

/** What follows a successful switch: stay on the current screen, or open that account's profile. */
type AfterSwitch = 'stay' | 'profile'

export const walletAccountMenuMachine = setup({
  types: {
    context: {} as {
      targetAccountIndex: number | null
      afterSwitch: AfterSwitch
      error: MenuError
    },
    events: {} as
      | { type: 'TOGGLE' }
      | { type: 'CLOSE' }
      | { type: 'CHOOSE'; accountIndex: number }
      | { type: 'EDIT_PROFILE'; accountIndex: number; active: boolean }
      | { type: 'SWITCHED' }
      | { type: 'CREATE' }
      | { type: 'CREATED' }
      | { type: 'FAIL'; error: string },
  },
  actions: {
    /** Provided by the projection: navigate to Publish identity. */
    openProfile: () => {},
  },
}).createMachine({
  id: 'walletAccountMenu',
  initial: 'closed',
  context: {
    targetAccountIndex: null,
    afterSwitch: 'stay',
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
            afterSwitch: 'stay',
            error: null,
          }),
        },
        EDIT_PROFILE: [
          {
            guard: ({ event }) => event.active,
            target: 'closed',
            actions: [assign({ error: null }), 'openProfile'],
          },
          {
            target: 'switching',
            actions: assign({
              targetAccountIndex: ({ event }) => event.accountIndex,
              afterSwitch: 'profile',
              error: null,
            }),
          },
        ],
        CREATE: {
          target: 'creating',
          actions: assign({ error: null }),
        },
      },
    },
    switching: {
      on: {
        SWITCHED: [
          {
            guard: ({ context }) => context.afterSwitch === 'profile',
            target: 'closed',
            actions: [assign({ targetAccountIndex: null, afterSwitch: 'stay', error: null }), 'openProfile'],
          },
          {
            target: 'closed',
            actions: assign({ targetAccountIndex: null, afterSwitch: 'stay', error: null }),
          },
        ],
        FAIL: {
          target: 'open',
          actions: assign({ afterSwitch: 'stay', error: ({ event }) => event.error }),
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
  },
})
