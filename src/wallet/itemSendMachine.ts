/**
 * Collectable item send phases (BRC-150 remittance + P2PKH tip).
 *
 * Parent: `collectableSendMachine` (p2pkhSend state). createAction is always
 * `noSend` — the settle chart (`ItemSettlePath`) owns who may broadcast.
 * `peerDeliver` has no `BROADCASTED` edge. After inbox delivery, sender
 * silently `postBeef` (`confirmBroadcast`) so the tx is on-chain even if the
 * payee never broadcasts. Required sender broadcast is `senderFallback`.
 */
import { assign, setup, type SnapshotFrom } from 'xstate'
import type { ItemSettlePath } from './itemSettlePath'

export type ItemSendPhase =
  | 'idle'
  | 'building'
  | 'createAction'
  | 'signing'
  | 'chooseSettle'
  | 'peerDeliver'
  | 'selfReceive'
  | 'externalBroadcast'
  | 'confirmBroadcast'
  | 'senderFallback'
  | 'done'
  | 'failed'

export type ItemSendContext = {
  outpoint: string
  settlePath: ItemSettlePath | null
  txid: string | null
  error: string | null
}

export type ItemSendEvent =
  | { type: 'START'; outpoint: string; settlePath: ItemSettlePath }
  | { type: 'RETRY_BROADCAST'; outpoint: string; txid: string }
  | { type: 'BUILT' }
  | { type: 'CREATED'; txid?: string }
  | { type: 'SIGNED'; txid: string }
  | { type: 'DELIVERED' }
  | { type: 'DELIVER_FAILED' }
  | { type: 'BROADCASTED' }
  | { type: 'SKIPPED' }
  | { type: 'FAIL'; error: string }
  | { type: 'RESET' }

export const itemSendMachine = setup({
  types: {
    context: {} as ItemSendContext,
    events: {} as ItemSendEvent,
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
    beginRetryBroadcast: assign(({ event }) =>
      event.type === 'RETRY_BROADCAST'
        ? {
            outpoint: event.outpoint,
            settlePath: null,
            txid: event.txid,
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
  id: 'itemSend',
  initial: 'idle',
  context: { outpoint: '', settlePath: null, txid: null, error: null },
  states: {
    idle: {
      on: {
        START: { target: 'building', actions: 'begin' },
        RETRY_BROADCAST: {
          target: 'confirmBroadcast',
          actions: 'beginRetryBroadcast',
        },
      },
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
    /** Atomic BEEF / remittance to peer — sender must not broadcast from this state. */
    peerDeliver: {
      on: {
        DELIVERED: 'confirmBroadcast',
        DELIVER_FAILED: 'senderFallback',
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

export type ItemSendSnapshot = SnapshotFrom<typeof itemSendMachine>

/** Sender postBeef is legal only in these states — never `peerDeliver`. */
export function maySenderBroadcast(snapshot: ItemSendSnapshot): boolean {
  return (
    snapshot.matches('selfReceive') ||
    snapshot.matches('externalBroadcast') ||
    snapshot.matches('confirmBroadcast') ||
    snapshot.matches('senderFallback')
  )
}

export function isSilentSenderBroadcast(snapshot: ItemSendSnapshot): boolean {
  return snapshot.matches('confirmBroadcast')
}

export function mustDeliverToPeer(snapshot: ItemSendSnapshot): boolean {
  return snapshot.matches('peerDeliver')
}
