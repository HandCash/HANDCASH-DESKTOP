/**
 * Soft-latch (BRC-150 / P2PKH tip) send phases.
 *
 * Parent: `collectableSendMachine` (softLatch state). createAction may return a
 * txid atomically or a signableTransaction that needs `signAction` — both are
 * explicit phases so a mid-sign failure cannot look like a successful send.
 */
import { assign, setup } from 'xstate'

export type SoftLatchSendPhase =
  | 'idle'
  | 'building'
  | 'createAction'
  | 'signing'
  | 'done'
  | 'failed'

export type SoftLatchSendContext = {
  outpoint: string
  txid: string | null
  error: string | null
}

export type SoftLatchSendEvent =
  | { type: 'START'; outpoint: string }
  | { type: 'BUILT' }
  | { type: 'CREATED'; txid?: string }
  | { type: 'NEEDS_SIGN' }
  | { type: 'SIGNED'; txid: string }
  | { type: 'FAIL'; error: string }
  | { type: 'RESET' }

export const softLatchSendMachine = setup({
  types: {
    context: {} as SoftLatchSendContext,
    events: {} as SoftLatchSendEvent,
  },
  actions: {
    begin: assign(({ event }) =>
      event.type === 'START'
        ? { outpoint: event.outpoint, txid: null, error: null }
        : {},
    ),
    setTxid: assign(({ event }) => {
      if (event.type === 'CREATED' && event.txid) return { txid: event.txid }
      if (event.type === 'SIGNED') return { txid: event.txid }
      return {}
    }),
    setError: assign(({ event }) =>
      event.type === 'FAIL' ? { error: event.error } : {},
    ),
    clear: assign({ outpoint: '', txid: null, error: null }),
  },
  guards: {
    createReturnedTxid: ({ event }) =>
      event.type === 'CREATED' && typeof event.txid === 'string' && event.txid.length > 0,
    createNeedsSign: ({ event }) =>
      event.type === 'CREATED' && !(typeof event.txid === 'string' && event.txid.length > 0),
  },
}).createMachine({
  id: 'softLatchSend',
  initial: 'idle',
  context: { outpoint: '', txid: null, error: null },
  states: {
    idle: {
      on: { START: { target: 'building', actions: 'begin' } },
    },
    building: {
      on: {
        BUILT: 'createAction',
        FAIL: { target: 'failed', actions: 'setError' },
      },
    },
    createAction: {
      on: {
        CREATED: [
          {
            guard: 'createReturnedTxid',
            target: 'done',
            actions: 'setTxid',
          },
          {
            guard: 'createNeedsSign',
            target: 'signing',
          },
        ],
        FAIL: { target: 'failed', actions: 'setError' },
      },
    },
    signing: {
      on: {
        SIGNED: { target: 'done', actions: 'setTxid' },
        FAIL: { target: 'failed', actions: 'setError' },
      },
    },
    done: {
      on: { RESET: { target: 'idle', actions: 'clear' } },
    },
    failed: {
      on: { RESET: { target: 'idle', actions: 'clear' } },
    },
  },
})
