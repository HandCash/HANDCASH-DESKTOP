/**
 * Soft-latch (BRC-150 / P2PKH tip) send phases.
 *
 * Parent: `collectableSendMachine` (softLatch state). createAction is always
 * `noSend` — the settle chart (`ItemSettlePath`) owns who may broadcast.
 * `peerDeliver` has no `BROADCASTED` edge until `DELIVER_FAILED`.
 */
import { assign, setup, type SnapshotFrom } from 'xstate'
import type { ItemSettlePath } from './itemSettlePath'

export type SoftLatchSendPhase =
  | 'idle'
  | 'building'
  | 'createAction'
  | 'signing'
  | 'chooseSettle'
  | 'peerDeliver'
  | 'selfReceive'
  | 'externalBroadcast'
  | 'senderFallback'
  | 'done'
  | 'failed'

export type SoftLatchSendContext = {
  outpoint: string
  settlePath: ItemSettlePath | null
  txid: string | null
  error: string | null
}

export type SoftLatchSendEvent =
  | { type: 'START'; outpoint: string; settlePath: ItemSettlePath }
  | { type: 'BUILT' }
  | { type: 'CREATED'; txid?: string }
  | { type: 'SIGNED'; txid: string }
  | { type: 'DELIVERED' }
  | { type: 'DELIVER_FAILED' }
  | { type: 'BROADCASTED' }
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
        ? {
            outpoint: event.outpoint,
            settlePath: event.settlePath,
            txid: null,
            error: null,
          }
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
    clear: assign({
      outpoint: '',
      settlePath: null,
      txid: null,
      error: null,
    }),
  },
  guards: {
    createReturnedTxid: ({ event }) =>
      event.type === 'CREATED' &&
      typeof event.txid === 'string' &&
      event.txid.length > 0,
    createNeedsSign: ({ event }) =>
      event.type === 'CREATED' &&
      !(typeof event.txid === 'string' && event.txid.length > 0),
    chosePeerDeliver: ({ context }) => context.settlePath?.settle === 'peerDeliver',
    choseSelfReceive: ({ context }) => context.settlePath?.settle === 'selfReceive',
    choseExternalBroadcast: ({ context }) =>
      context.settlePath?.settle === 'externalBroadcast',
  },
}).createMachine({
  id: 'softLatchSend',
  initial: 'idle',
  context: { outpoint: '', settlePath: null, txid: null, error: null },
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
            target: 'chooseSettle',
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
        SIGNED: { target: 'chooseSettle', actions: 'setTxid' },
        FAIL: { target: 'failed', actions: 'setError' },
      },
    },
    chooseSettle: {
      always: [
        { guard: 'chosePeerDeliver', target: 'peerDeliver' },
        { guard: 'choseSelfReceive', target: 'selfReceive' },
        { guard: 'choseExternalBroadcast', target: 'externalBroadcast' },
        {
          target: 'failed',
          actions: assign({ error: 'Item settle path was not classified' }),
        },
      ],
    },
    /** Atomic BEEF to peer — sender must not broadcast from this state. */
    peerDeliver: {
      on: {
        DELIVERED: 'done',
        DELIVER_FAILED: 'senderFallback',
        FAIL: { target: 'failed', actions: 'setError' },
      },
    },
    selfReceive: {
      on: {
        BROADCASTED: 'done',
        FAIL: { target: 'failed', actions: 'setError' },
      },
    },
    externalBroadcast: {
      on: {
        BROADCASTED: 'done',
        FAIL: { target: 'failed', actions: 'setError' },
      },
    },
    senderFallback: {
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

export type SoftLatchSendSnapshot = SnapshotFrom<typeof softLatchSendMachine>

/** Sender postBeef is legal only in these states — never `peerDeliver`. */
export function maySenderBroadcast(snapshot: SoftLatchSendSnapshot): boolean {
  return (
    snapshot.matches('selfReceive') ||
    snapshot.matches('externalBroadcast') ||
    snapshot.matches('senderFallback')
  )
}

export function mustDeliverToPeer(snapshot: SoftLatchSendSnapshot): boolean {
  return snapshot.matches('peerDeliver')
}
