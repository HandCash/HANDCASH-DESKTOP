/**
 * BRC-29 peer-pay phases — Babbage / wallet-toolbox shape.
 *
 * `createAction` broadcasts immediately (no `noSend`). Remittance then goes to
 * the payee inbox. Inbox failure does not create a second tx; remittance retries
 * from the local outbox.
 */
import { assign, setup, type SnapshotFrom } from 'xstate'
import type { Brc29SettlePath } from './brc29SettlePath'

export type Brc29SendContext = {
  payee: string
  satoshis: number
  settlePath: Brc29SettlePath | null
  txid: string | null
  error: string | null
}

export type Brc29SendEvent =
  | { type: 'START'; payee: string; satoshis: number; settlePath: Brc29SettlePath }
  | { type: 'READY' }
  | { type: 'BROADCASTED'; txid: string }
  | { type: 'BEEF_IN_BOX' }
  | { type: 'REMIT_IN_BOX' }
  | { type: 'BOX_UNREACHABLE' }
  | { type: 'SETTLED' }
  | { type: 'FAIL'; error: string }
  | { type: 'RESET' }

export const brc29SendMachine = setup({
  types: {
    context: {} as Brc29SendContext,
    events: {} as Brc29SendEvent,
  },
  actions: {
    begin: assign(({ event }) =>
      event.type === 'START'
        ? {
            payee: event.payee,
            satoshis: event.satoshis,
            settlePath: event.settlePath,
            txid: null,
            error: null,
          }
        : {},
    ),
    setTxid: assign(({ event }) =>
      event.type === 'BROADCASTED' ? { txid: event.txid, error: null } : {},
    ),
    setError: assign(({ event }) =>
      event.type === 'FAIL' ? { error: event.error } : {},
    ),
    clear: assign({
      payee: '',
      satoshis: 0,
      settlePath: null,
      txid: null,
      error: null,
    }),
  },
  guards: {
    chosePeerDeliver: ({ context }) => context.settlePath?.settle === 'peerDeliver',
    choseSelfReceive: ({ context }) => context.settlePath?.settle === 'selfReceive',
  },
}).createMachine({
  id: 'brc29Send',
  initial: 'idle',
  context: {
    payee: '',
    satoshis: 0,
    settlePath: null,
    txid: null,
    error: null,
  },
  states: {
    idle: {
      on: { START: { target: 'preparing', actions: 'begin' } },
    },
    preparing: {
      on: {
        READY: 'broadcasting',
        FAIL: { target: 'failed', actions: 'setError' },
      },
    },
    broadcasting: {
      on: {
        BROADCASTED: { target: 'chooseSettle', actions: 'setTxid' },
        FAIL: { target: 'failed', actions: 'setError' },
      },
    },
    chooseSettle: {
      always: [
        { guard: 'chosePeerDeliver', target: 'peerNotify' },
        { guard: 'choseSelfReceive', target: 'selfReceive' },
        {
          target: 'failed',
          actions: assign({ error: 'BRC-29 settle path was not classified' }),
        },
      ],
    },
    /** Remittance to peer inbox — send already broadcast. */
    peerNotify: {
      on: {
        BEEF_IN_BOX: 'done',
        REMIT_IN_BOX: 'done',
        BOX_UNREACHABLE: 'done',
        FAIL: { target: 'failed', actions: 'setError' },
      },
    },
    selfReceive: {
      on: {
        SETTLED: 'done',
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

export type Brc29SendSnapshot = SnapshotFrom<typeof brc29SendMachine>

export function mustBrc29DeliverToPeer(snapshot: Brc29SendSnapshot): boolean {
  return snapshot.matches('peerNotify')
}

export function mustBrc29SelfReceive(snapshot: Brc29SendSnapshot): boolean {
  return snapshot.matches('selfReceive')
}
