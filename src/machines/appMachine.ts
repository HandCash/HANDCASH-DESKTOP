import { setup, assign } from 'xstate'

export type Chain = 'main' | 'test'

export type WalletProfile = {
  handle: string
  identityKey: string
  address: string
  chain: Chain
}

export type AppContext = {
  profile: WalletProfile | null
  balanceSats: number
  error: string | null
  bridgeOnline: boolean
  version: string
}

export type AppEvent =
  | { type: 'BOOTSTRAPPED'; hasVault: boolean; version: string }
  | { type: 'CREATED'; profile: WalletProfile; balanceSats: number }
  | { type: 'UNLOCKED'; profile: WalletProfile; balanceSats: number }
  | { type: 'LOCK' }
  | { type: 'REFRESHED'; balanceSats: number }
  | { type: 'BRIDGE'; online: boolean }
  | { type: 'FAIL'; error: string }
  | { type: 'CLEAR_ERROR' }
  | { type: 'OPEN_SEND' }
  | { type: 'CLOSE_SEND' }
  | { type: 'SENT'; balanceSats: number }

/**
 * Chart: appSession
 * States: boot → onboarding | locked | ready | sending
 * Events: BOOTSTRAPPED, CREATED, UNLOCKED, LOCK, OPEN_SEND, CLOSE_SEND, SENT, FAIL…
 */
export const appMachine = setup({
  types: {
    context: {} as AppContext,
    events: {} as AppEvent,
  },
}).createMachine({
  id: 'appSession',
  initial: 'boot',
  context: {
    profile: null,
    balanceSats: 0,
    error: null,
    bridgeOnline: false,
    version: '0.0.0',
  },
  on: {
    BRIDGE: {
      actions: assign({ bridgeOnline: ({ event }) => event.online }),
    },
  },
  states: {
    boot: {
      on: {
        BOOTSTRAPPED: [
          {
            guard: ({ event }) => event.hasVault,
            target: 'locked',
            actions: assign({
              version: ({ event }) => event.version,
              error: null,
            }),
          },
          {
            target: 'onboarding',
            actions: assign({
              version: ({ event }) => event.version,
              error: null,
            }),
          },
        ],
        FAIL: {
          target: 'failure',
          actions: assign({ error: ({ event }) => event.error }),
        },
      },
    },
    onboarding: {
      on: {
        CREATED: {
          target: 'ready',
          actions: assign({
            profile: ({ event }) => event.profile,
            balanceSats: ({ event }) => event.balanceSats,
            error: null,
          }),
        },
        FAIL: {
          actions: assign({ error: ({ event }) => event.error }),
        },
        CLEAR_ERROR: {
          actions: assign({ error: null }),
        },
      },
    },
    locked: {
      on: {
        UNLOCKED: {
          target: 'ready',
          actions: assign({
            profile: ({ event }) => event.profile,
            balanceSats: ({ event }) => event.balanceSats,
            error: null,
          }),
        },
        FAIL: {
          actions: assign({ error: ({ event }) => event.error }),
        },
        CLEAR_ERROR: {
          actions: assign({ error: null }),
        },
      },
    },
    ready: {
      on: {
        LOCK: {
          target: 'locked',
          actions: assign({ profile: null, balanceSats: 0 }),
        },
        OPEN_SEND: 'sending',
        REFRESHED: {
          actions: assign({ balanceSats: ({ event }) => event.balanceSats }),
        },
        FAIL: {
          actions: assign({ error: ({ event }) => event.error }),
        },
        CLEAR_ERROR: {
          actions: assign({ error: null }),
        },
      },
    },
    sending: {
      on: {
        CLOSE_SEND: 'ready',
        SENT: {
          target: 'ready',
          actions: assign({
            balanceSats: ({ event }) => event.balanceSats,
            error: null,
          }),
        },
        BRIDGE: {
          actions: assign({ bridgeOnline: ({ event }) => event.online }),
        },
        FAIL: {
          actions: assign({ error: ({ event }) => event.error }),
        },
        CLEAR_ERROR: {
          actions: assign({ error: null }),
        },
      },
    },
    failure: {
      on: {
        BOOTSTRAPPED: 'boot',
        CLEAR_ERROR: {
          target: 'boot',
          actions: assign({ error: null }),
        },
      },
    },
  },
})
