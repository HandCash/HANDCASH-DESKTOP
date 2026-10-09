import { assign, setup } from 'xstate'

type MenuError = string | null

/** What follows a successful switch: stay on the current screen, or open that account's profile. */
type AfterSwitch = 'stay' | 'profile'

/**
 * Wallet menu: switch, create, and move accounts between devices.
 *
 * An account another install holds is taken (`taking`), with a confirmation
 * when that install still holds it (`confirmTakeover`). The active account is
 * released after a confirmation (`confirmRelease` → `releasing`), and the menu
 * then switches to another held account or creates one. `DISPLACED` arrives
 * when a holder check finds another install took the active account.
 */
export const walletAccountMenuMachine = setup({
  types: {
    context: {} as {
      targetAccountIndex: number | null
      afterSwitch: AfterSwitch
      /** Taking over from an install that still holds the account. */
      force: boolean
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
      | { type: 'TAKE'; accountIndex: number }
      | { type: 'HELD_ELSEWHERE' }
      | { type: 'TAKEN' }
      | { type: 'RELEASE' }
      | { type: 'RELEASED'; nextAccountIndex: number | null }
      | { type: 'CONFIRM' }
      | { type: 'CANCEL' }
      | { type: 'DISPLACED'; nextAccountIndex: number | null }
      | { type: 'FAIL'; error: string },
  },
  actions: {
    /** Provided by the projection: navigate to Publish identity. */
    openProfile: () => {},
    /** Switch target after a release or a displacement. */
    targetNextAccount: assign(({ event }) => ({
      targetAccountIndex:
        event.type === 'RELEASED' || event.type === 'DISPLACED' ? event.nextAccountIndex : null,
      afterSwitch: 'stay' as const,
      force: false,
      error: null,
    })),
    clearError: assign({ force: false, error: null }),
  },
  guards: {
    hasNextAccount: ({ event }) =>
      (event.type === 'RELEASED' || event.type === 'DISPLACED') && event.nextAccountIndex != null,
  },
}).createMachine({
  id: 'walletAccountMenu',
  initial: 'closed',
  context: {
    targetAccountIndex: null,
    afterSwitch: 'stay',
    force: false,
    error: null,
  },
  states: {
    closed: {
      on: {
        TOGGLE: 'open',
        DISPLACED: [
          { guard: 'hasNextAccount', target: 'switching', actions: 'targetNextAccount' },
          { target: 'creating', actions: 'clearError' },
        ],
      },
    },
    open: {
      on: {
        TOGGLE: 'closed',
        CLOSE: 'closed',
        DISPLACED: [
          { guard: 'hasNextAccount', target: 'switching', actions: 'targetNextAccount' },
          { target: 'creating', actions: 'clearError' },
        ],
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
        TAKE: {
          target: 'taking',
          actions: assign({
            targetAccountIndex: ({ event }) => event.accountIndex,
            force: false,
            error: null,
          }),
        },
        RELEASE: {
          target: 'confirmRelease',
          actions: assign({ error: null }),
        },
      },
    },
    taking: {
      on: {
        TAKEN: {
          target: 'switching',
          actions: assign({ afterSwitch: 'stay', force: false }),
        },
        HELD_ELSEWHERE: 'confirmTakeover',
        FAIL: {
          target: 'open',
          actions: assign({ force: false, error: ({ event }) => event.error }),
        },
      },
    },
    confirmTakeover: {
      on: {
        CONFIRM: { target: 'taking', actions: assign({ force: true }) },
        CANCEL: { target: 'open', actions: assign({ targetAccountIndex: null, force: false }) },
        DISPLACED: [
          { guard: 'hasNextAccount', target: 'switching', actions: 'targetNextAccount' },
          { target: 'creating', actions: 'clearError' },
        ],
      },
    },
    confirmRelease: {
      on: {
        CONFIRM: 'releasing',
        CANCEL: 'open',
        DISPLACED: [
          { guard: 'hasNextAccount', target: 'switching', actions: 'targetNextAccount' },
          { target: 'creating', actions: 'clearError' },
        ],
      },
    },
    releasing: {
      on: {
        RELEASED: [
          { guard: 'hasNextAccount', target: 'switching', actions: 'targetNextAccount' },
          { target: 'creating', actions: 'clearError' },
        ],
        FAIL: {
          target: 'open',
          actions: assign({ error: ({ event }) => event.error }),
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
