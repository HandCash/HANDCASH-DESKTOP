import { assign, setup, type SnapshotFrom } from 'xstate'
import type { DevWalletRecoverPlan } from './devKeys'

export type ServerWalletRecoverContext = {
  plan: DevWalletRecoverPlan | null
  txid: string | null
  error: string | null
}

export type ServerWalletRecoverEvent =
  | { type: 'START'; plan: DevWalletRecoverPlan }
  | { type: 'SPENT'; txid: string }
  | { type: 'INTERNALIZED' }
  | { type: 'FAIL'; error: string }
  | { type: 'RESET' }

/**
 * Server wallet Recover, money only: the server wallet signs and broadcasts a
 * BRC-29 payment to this wallet, which then internalizes it. `finish` re-runs
 * only the internalize step of a recovery the server already broadcast.
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
    setTxid: assign(({ event }) => (event.type === 'SPENT' ? { txid: event.txid } : {})),
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
        { guard: 'recover', target: 'spending' },
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
    spending: {
      on: {
        SPENT: { target: 'internalizing', actions: 'setTxid' },
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
