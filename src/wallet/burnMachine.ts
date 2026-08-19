import { assign, setup, type SnapshotFrom } from 'xstate'
import type { BurnPlan } from './burnPlan'

export type BurnMachineContext = {
  plan: BurnPlan | null
  reference: string | null
  txid: string | null
  error: string | null
}

export type BurnMachineEvent =
  | { type: 'START'; plan: BurnPlan }
  | { type: 'BUILT'; reference?: string }
  | { type: 'SIGNED'; txid: string }
  | { type: 'BROADCASTED' }
  | { type: 'INTERNALIZED' }
  | { type: 'REFRESHED' }
  | { type: 'FAIL'; error: string }
  | { type: 'RESET' }

export const burnMachine = setup({
  types: {
    context: {} as BurnMachineContext,
    events: {} as BurnMachineEvent,
  },
  guards: {
    executable: ({ context }) =>
      context.plan?.path === 'burnBsv21' ||
      context.plan?.path === 'burnOneSat',
  },
  actions: {
    begin: assign(({ event }) =>
      event.type === 'START'
        ? { plan: event.plan, reference: null, txid: null, error: null }
        : {},
    ),
    setReference: assign(({ event }) =>
      event.type === 'BUILT' ? { reference: event.reference ?? null } : {},
    ),
    setTxid: assign(({ event }) =>
      event.type === 'SIGNED' ? { txid: event.txid } : {},
    ),
    setError: assign(({ event }) =>
      event.type === 'FAIL' ? { error: event.error } : {},
    ),
    clear: assign({ plan: null, reference: null, txid: null, error: null }),
  },
}).createMachine({
  id: 'burn',
  initial: 'idle',
  context: { plan: null, reference: null, txid: null, error: null },
  states: {
    idle: { on: { START: { target: 'planning', actions: 'begin' } } },
    planning: {
      always: [
        { guard: 'executable', target: 'building' },
        {
          target: 'failed',
          actions: assign(({ context }) => ({
            error:
              context.plan?.path === 'refuse'
                ? context.plan.reason
                : 'Burn plan was not classified',
          })),
        },
      ],
    },
    building: {
      on: {
        BUILT: { target: 'signing', actions: 'setReference' },
        FAIL: { target: 'failed', actions: 'setError' },
      },
    },
    signing: {
      on: {
        SIGNED: { target: 'broadcasting', actions: 'setTxid' },
        FAIL: { target: 'failed', actions: 'setError' },
      },
    },
    broadcasting: {
      on: {
        BROADCASTED: { target: 'internalizing' },
        FAIL: { target: 'failed', actions: 'setError' },
      },
    },
    internalizing: {
      on: {
        INTERNALIZED: { target: 'refreshing' },
        FAIL: { target: 'failed', actions: 'setError' },
      },
    },
    refreshing: {
      on: {
        REFRESHED: { target: 'done' },
        FAIL: { target: 'failed', actions: 'setError' },
      },
    },
    done: { on: { RESET: { target: 'idle', actions: 'clear' } } },
    failed: { on: { RESET: { target: 'idle', actions: 'clear' } } },
  },
})

export type BurnSnapshot = SnapshotFrom<typeof burnMachine>
