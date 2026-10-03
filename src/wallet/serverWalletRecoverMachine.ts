import { assign, setup, type SnapshotFrom } from 'xstate'
import type { ServerWalletRecoverPlan } from './serverWallet'

export type ServerWalletRecoverContext = {
  plan: ServerWalletRecoverPlan | null
  txid: string | null
  error: string | null
}

export type ServerWalletRecoverEvent =
  | { type: 'START'; plan: ServerWalletRecoverPlan }
  | { type: 'SIGNED'; txid: string }
  | { type: 'REGISTERED' }
  | { type: 'INTERNALIZED' }
  | { type: 'FAIL'; error: string }
  | { type: 'RESET' }

/**
 * Server wallet Recover: the only path on which this wallet spends the server
 * key. Tracked outputs → one self payment → signedSendLifecycle → internalize.
 * `finish` re-runs only the internalize step of an already registered recovery.
 */
export const serverWalletRecoverMachine = setup({
  types: {
    context: {} as ServerWalletRecoverContext,
    events: {} as ServerWalletRecoverEvent,
  },
  guards: {
    recover: ({ context }) => context.plan?.path === 'recover',
    finish: ({ context }) => context.plan?.path === 'finish',
  },
  actions: {
    begin: assign(({ event }) =>
      event.type === 'START' ? { plan: event.plan, txid: null, error: null } : {},
    ),
    setTxid: assign(({ event }) => (event.type === 'SIGNED' ? { txid: event.txid } : {})),
    setError: assign(({ event }) => (event.type === 'FAIL' ? { error: event.error } : {})),
    clear: assign({ plan: null, txid: null, error: null }),
  },
}).createMachine({
  id: 'serverWalletRecover',
  initial: 'idle',
  context: { plan: null, txid: null, error: null },
  states: {
    idle: { on: { START: { target: 'planning', actions: 'begin' } } },
    planning: {
      always: [
        { guard: 'recover', target: 'signing' },
        {
          guard: 'finish',
          target: 'internalizing',
          actions: assign(({ context }) => ({
            txid: context.plan?.path === 'finish' ? context.plan.pending.txid : null,
          })),
        },
        {
          target: 'failed',
          actions: assign(({ context }) => ({
            error:
              context.plan?.path === 'refuse'
                ? context.plan.reason
                : 'Recover plan was not classified',
          })),
        },
      ],
    },
    signing: {
      on: {
        SIGNED: { target: 'registering', actions: 'setTxid' },
        FAIL: { target: 'failed', actions: 'setError' },
      },
    },
    registering: {
      on: {
        REGISTERED: { target: 'internalizing' },
        FAIL: { target: 'failed', actions: 'setError' },
      },
    },
    internalizing: {
      on: {
        INTERNALIZED: { target: 'done' },
        FAIL: { target: 'failed', actions: 'setError' },
      },
    },
    done: { on: { RESET: { target: 'idle', actions: 'clear' } } },
    failed: { on: { RESET: { target: 'idle', actions: 'clear' } } },
  },
})

export type ServerWalletRecoverSnapshot = SnapshotFrom<typeof serverWalletRecoverMachine>
