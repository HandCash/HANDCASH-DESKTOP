import { assign, enqueueActions, setup } from 'xstate'

type MenuError = string | null

/** What follows a successful switch: stay on the current screen, or open that account's profile. */
type AfterSwitch = 'stay' | 'profile'

/**
 * Wallet menu: switch and create accounts.
 *
 * Choosing an account another install holds only views it (`VIEW`): the
 * projection shows its cached balance read-only and never moves it. Viewing
 * and selecting never move an account; a spend from a viewed account moves it
 * here in the background first (`accountView.takeViewedAccountForSpend`) and
 * fails closed when the move does not succeed.
 * `DISPLACED` arrives when this install stops holding the active account:
 * another install took it, or asked for it and this one released it. Keep
 * its local view open; holding guards refuse signing and backup writes. A busy
 * menu records it and checks again when it settles, without switching away.
 */
export const walletAccountMenuMachine = setup({
  types: {
    context: {} as {
      targetAccountIndex: number | null
      afterSwitch: AfterSwitch
      error: MenuError
      /** A displacement arrived while busy and waits for the menu to settle. */
      displacedWhileBusy: boolean
    },
    events: {} as
      | { type: 'TOGGLE' }
      | { type: 'CLOSE' }
      | { type: 'CHOOSE'; accountIndex: number }
      | { type: 'EDIT_PROFILE'; accountIndex: number; active: boolean }
      // Runtime selected and cached projection painted; local reads continue outside the menu.
      | { type: 'SWITCHED' }
      | { type: 'CREATE' }
      | { type: 'CREATED' }
      // View an account held on another device; never moves it.
      | { type: 'VIEW'; accountIndex: number }
      | { type: 'DISPLACED'; nextAccountIndex: number | null }
      | { type: 'FAIL'; error: string },
  },
  actions: {
    /** Provided by the projection: navigate to Publish identity. */
    openProfile: () => {},
    /** Provided by the projection: show the chosen account read-only. */
    viewAccount: () => {},
    /** Provided by the projection: check again whether the open account is still held here. */
    recheckDisplacement: () => {},
    /** Switch target after a displacement. */
    targetNextAccount: assign(({ event }) => ({
      targetAccountIndex: event.type === 'DISPLACED' ? event.nextAccountIndex : null,
      afterSwitch: 'stay' as const,
      error: null,
      displacedWhileBusy: false,
    })),
    clearError: assign({ error: null, displacedWhileBusy: false }),
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
    error: null,
    displacedWhileBusy: false,
  },
  states: {
    closed: {
      entry: 'settleDisplacement',
      on: {
        TOGGLE: 'open',
        DISPLACED: { actions: 'clearError' },
      },
    },
    open: {
      entry: 'settleDisplacement',
      on: {
        TOGGLE: 'closed',
        CLOSE: 'closed',
        DISPLACED: { actions: 'clearError' },
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
        VIEW: {
          target: 'closed',
          actions: [assign({ targetAccountIndex: null, error: null }), 'viewAccount'],
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
