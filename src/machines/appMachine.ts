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
  /** True while the newly selected wallet's Toolbox balance is being read. */
  balancePending: boolean
  error: string | null
  bridgeOnline: boolean
  version: string
  /** When true, onboarding only offers restore (toolbox orphans, no vault). */
  recoveryOnly: boolean
}

export type AppEvent =
  | { type: 'BOOTSTRAPPED'; hasVault: boolean; version: string; orphanedToolbox?: boolean }
  | { type: 'CREATED'; profile: WalletProfile; balanceSats: number }
  | { type: 'UNLOCKED'; profile: WalletProfile; balanceSats: number }
  | { type: 'LOCK' }
  | { type: 'REFRESHED'; balanceSats: number }
  | { type: 'BRIDGE'; online: boolean }
  | { type: 'FAIL'; error: string }
  | { type: 'CLEAR_ERROR' }
  | { type: 'SENT'; balanceSats: number }
  | { type: 'ACCOUNT_SWITCH_STARTED'; profile: WalletProfile }
  | { type: 'ACCOUNT_SWITCHED'; profile: WalletProfile; balanceSats: number }

type Bootstrapped = Extract<AppEvent, { type: 'BOOTSTRAPPED' }>

/**
 * Chart: appSession
 * States: boot → onboarding | locked | ready | failure
 * Events: BOOTSTRAPPED, CREATED, UNLOCKED, LOCK, SENT, REFRESHED, FAIL…
 */
export const appMachine = setup({
  types: {
    context: {} as AppContext,
    events: {} as AppEvent,
  },
  guards: {
    hasVault: ({ event }) => (event as Bootstrapped).hasVault,
    orphanedToolbox: ({ event }) => Boolean((event as Bootstrapped).orphanedToolbox),
  },
  actions: {
    bootToWallet: assign(({ event }) => ({
      version: (event as Bootstrapped).version,
      recoveryOnly: false,
      error: null,
    })),
    bootToRestoreOnly: assign(({ event }) => ({
      version: (event as Bootstrapped).version,
      recoveryOnly: true,
      error:
        'This device has wallet data but missing unlock keys. Restore with a recovery phrase, BRC-140 shares, or emergency key — creating a new wallet is blocked.',
    })),
  },
}).createMachine({
  id: 'appSession',
  initial: 'boot',
  context: {
    profile: null,
    balanceSats: 0,
    balancePending: false,
    error: null,
    bridgeOnline: false,
    version: '0.0.0',
    recoveryOnly: false,
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
          { guard: 'hasVault', target: 'locked', actions: 'bootToWallet' },
          // IndexedDB has wallet users but durable vault is missing — restore only.
          { guard: 'orphanedToolbox', target: 'onboarding', actions: 'bootToRestoreOnly' },
          { target: 'onboarding', actions: 'bootToWallet' },
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
            balancePending: false,
            recoveryOnly: false,
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
            balancePending: false,
            error: null,
          }),
        },
        // Restore-replace from locked mismatch UI
        CREATED: {
          target: 'ready',
          actions: assign({
            profile: ({ event }) => event.profile,
            balanceSats: ({ event }) => event.balanceSats,
            balancePending: false,
            recoveryOnly: false,
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
          actions: assign({ profile: null, balanceSats: 0, balancePending: false }),
        },
        SENT: {
          actions: assign({
            balanceSats: ({ event }) => event.balanceSats,
            balancePending: false,
            error: null,
          }),
        },
        REFRESHED: {
          actions: assign({
            balanceSats: ({ event }) => event.balanceSats,
            balancePending: false,
          }),
        },
        ACCOUNT_SWITCH_STARTED: {
          actions: assign({
            profile: ({ event }) => event.profile,
            balanceSats: 0,
            balancePending: true,
            error: null,
          }),
        },
        ACCOUNT_SWITCHED: {
          actions: assign({
            profile: ({ event }) => event.profile,
            balanceSats: ({ event }) => event.balanceSats,
            balancePending: false,
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
    failure: {
      on: {
        BOOTSTRAPPED: [
          { guard: 'hasVault', target: 'locked', actions: 'bootToWallet' },
          { guard: 'orphanedToolbox', target: 'onboarding', actions: 'bootToRestoreOnly' },
          { target: 'onboarding', actions: 'bootToWallet' },
        ],
        CLEAR_ERROR: {
          target: 'boot',
          actions: assign({ error: null }),
        },
      },
    },
  },
})
