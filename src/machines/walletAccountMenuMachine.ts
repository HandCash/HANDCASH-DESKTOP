import { assign, enqueueActions, setup } from 'xstate'
import type { AccountMovePhase } from '../wallet/accountMoveMachine'

type MenuError = string | null

/** What follows a successful switch: stay on the current screen, or open that account's profile. */
type AfterSwitch = 'stay' | 'profile'

/**
 * Wallet menu: switch and create accounts.
 *
 * Choosing an account another install holds moves it here (`moving`, driven
 * by `accountMoveMachine`; no step asks the user) and then switches to it.
 * `DISPLACED` arrives when this install stops holding the active account:
 * another install took it, or asked for it and this one released it. An idle
 * menu leaves the account at once; a busy one records it and asks for a fresh
 * check (`recheckDisplacement`) the moment it settles, so it is never dropped.
 */
export const walletAccountMenuMachine = setup({
  types: {
    context: {} as {
      targetAccountIndex: number | null
      afterSwitch: AfterSwitch
      /** Where a move here stands, for the row's status line. */
      movePhase: AccountMovePhase | null
      error: MenuError
      /** A displacement arrived while busy and waits for the menu to settle. */
      displacedWhileBusy: boolean
    },
    events: {} as
      | { type: 'TOGGLE' }
      | { type: 'CLOSE' }
      | { type: 'CHOOSE'; accountIndex: number }
      | { type: 'EDIT_PROFILE'; accountIndex: number; active: boolean }
      | { type: 'SWITCHED' }
      | { type: 'CREATE' }
      | { type: 'CREATED' }
      | { type: 'MOVE'; accountIndex: number }
      | { type: 'MOVE_PHASE'; phase: AccountMovePhase }
      | { type: 'MOVED' }
      | { type: 'DISPLACED'; nextAccountIndex: number | null }
      | { type: 'FAIL'; error: string },
  },
  actions: {
    /** Provided by the projection: navigate to Publish identity. */
    openProfile: () => {},
    /** Provided by the projection: check again whether the open account is still held here. */
    recheckDisplacement: () => {},
    /** Switch target after a displacement. */
    targetNextAccount: assign(({ event }) => ({
      targetAccountIndex: event.type === 'DISPLACED' ? event.nextAccountIndex : null,
      afterSwitch: 'stay' as const,
      movePhase: null,
      error: null,
      displacedWhileBusy: false,
    })),
    clearError: assign({ movePhase: null, error: null, displacedWhileBusy: false }),
    recordDisplacement: assign({ displacedWhileBusy: true }),
    /** On settling, act on a displacement recorded while busy. */
    settleDisplacement: enqueueActions(({ context, enqueue }) => {
      if (!context.displacedWhileBusy) return
      enqueue.assign({ displacedWhileBusy: false })
      enqueue('recheckDisplacement')
    }),
  },
  guards: {
    hasNextAccount: ({ event }) => event.type === 'DISPLACED' && event.nextAccountIndex != null,
  },
}).createMachine({
  id: 'walletAccountMenu',
  initial: 'closed',
  context: {
    targetAccountIndex: null,
    afterSwitch: 'stay',
    movePhase: null,
    error: null,
    displacedWhileBusy: false,
  },
  states: {
    closed: {
      entry: 'settleDisplacement',
      on: {
        TOGGLE: 'open',
        DISPLACED: [
          { guard: 'hasNextAccount', target: 'switching', actions: 'targetNextAccount' },
          { target: 'creating', actions: 'clearError' },
        ],
      },
    },
    open: {
      entry: 'settleDisplacement',
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
        MOVE: {
          target: 'moving',
          actions: assign({
            targetAccountIndex: ({ event }) => event.accountIndex,
            movePhase: 'reading',
            error: null,
          }),
        },
      },
    },
    moving: {
      on: {
        DISPLACED: { actions: 'recordDisplacement' },
        MOVE_PHASE: { actions: assign({ movePhase: ({ event }) => event.phase }) },
        MOVED: {
          target: 'switching',
          actions: assign({ afterSwitch: 'stay', movePhase: null }),
        },
        FAIL: {
          target: 'open',
          actions: assign({
            targetAccountIndex: null,
            movePhase: null,
            error: ({ event }) => event.error,
          }),
        },
      },
    },
    switching: {
      on: {
        DISPLACED: { actions: 'recordDisplacement' },
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
        DISPLACED: { actions: 'recordDisplacement' },
        CREATED: { target: 'closed', actions: assign({ error: null }) },
        FAIL: {
          target: 'open',
          actions: assign({ error: ({ event }) => event.error }),
        },
      },
    },
  },
})
