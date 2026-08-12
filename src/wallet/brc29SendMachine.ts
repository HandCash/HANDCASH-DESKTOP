/**
 * BRC-29 peer-pay phases.
 *
 * createAction is always `noSend`. Deliver remittance first (`peerDeliver`).
 * After the box accepts (or is unreachable), sender silently `postBeef` so the
 * tx is on-chain even if the payee never broadcasts.
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
  | { type: 'SIGNED'; txid: string }
  | { type: 'BEEF_IN_BOX' }
  | { type: 'REMIT_IN_BOX' }
  | { type: 'BOX_UNREACHABLE' }
  | { type: 'BROADCASTED' }
  | { type: 'SKIPPED' }
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
      event.type === 'SIGNED' ? { txid: event.txid, error: null } : {},
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
        READY: 'signing',
        FAIL: { target: 'failed', actions: 'setError' },
      },
    },
    signing: {
      on: {
        SIGNED: { target: 'chooseSettle', actions: 'setTxid' },
        FAIL: { target: 'failed', actions: 'setError' },
      },
    },
    chooseSettle: {
      always: [
        { guard: 'chosePeerDeliver', target: 'peerDeliver' },
        { guard: 'choseSelfReceive', target: 'selfReceive' },
        {
          target: 'failed',
          actions: assign({ error: 'BRC-29 settle path was not classified' }),
        },
      ],
    },
    /** Remittance (± inline Atomic BEEF) to peer — no sender broadcast here. */
    peerDeliver: {
      on: {
        BEEF_IN_BOX: 'confirmBroadcast',
        REMIT_IN_BOX: 'confirmBroadcast',
        BOX_UNREACHABLE: 'senderBroadcast',
        FAIL: { target: 'failed', actions: 'setError' },
      },
    },
    selfReceive: {
      on: {
        SETTLED: 'done',
        FAIL: { target: 'failed', actions: 'setError' },
      },
    },
    /** Silent sender postBeef after inbox delivery — failure does not fail the send. */
    confirmBroadcast: {
      on: {
        BROADCASTED: 'done',
        SKIPPED: 'done',
        FAIL: { target: 'failed', actions: 'setError' },
      },
    },
    senderBroadcast: {
      on: {
        BROADCASTED: 'done',
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

/** Sender postBeef is legal only after remittance left peerDeliver. */
export function mayBrc29SenderBroadcast(snapshot: Brc29SendSnapshot): boolean {
  return (
    snapshot.matches('confirmBroadcast') ||
    snapshot.matches('senderBroadcast') ||
    snapshot.matches('selfReceive')
  )
}

export function isBrc29SilentBroadcast(snapshot: Brc29SendSnapshot): boolean {
  return snapshot.matches('confirmBroadcast')
}

export function mustBrc29DeliverToPeer(snapshot: Brc29SendSnapshot): boolean {
  return snapshot.matches('peerDeliver')
}
