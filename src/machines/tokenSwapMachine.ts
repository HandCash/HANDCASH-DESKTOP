import { assign, setup, type SnapshotFrom } from 'xstate'
import type {
  TokenSwapCancelPath,
  TokenSwapClaimPath,
  TokenSwapMakePath,
  TokenSwapTakePath,
} from '../wallet/tokenSwapPath'

type Operation = 'make' | 'take' | 'claim' | 'cancel'

type Context = {
  operation: Operation | null
  path: TokenSwapMakePath | TokenSwapTakePath | TokenSwapClaimPath | TokenSwapCancelPath | null
  reference: string | null
  txid: string | null
  error: string | null
}

type Event =
  | { type: 'MAKE'; path: TokenSwapMakePath }
  | { type: 'TAKE'; path: TokenSwapTakePath }
  | { type: 'CLAIM'; path: TokenSwapClaimPath }
  | { type: 'CANCEL'; path: TokenSwapCancelPath }
  | { type: 'STAGED'; reference: string }
  | { type: 'SIGNED_UNKNOWN' }
  | { type: 'BROADCASTED'; txid: string }
  | { type: 'INGESTED' }
  | { type: 'COMMITTED' }
  | { type: 'RECOVER' }
  | { type: 'ABORTED'; error: string }
  | { type: 'FAIL'; error: string }

const OPERATION: Record<'MAKE' | 'TAKE' | 'CLAIM' | 'CANCEL', Operation> = {
  MAKE: 'make',
  TAKE: 'take',
  CLAIM: 'claim',
  CANCEL: 'cancel',
}

/**
 * One swap operation. make / take / cancel each sign one noSend transaction
 * (make: the escrow lot; take: the swap; cancel: the lot back home) and share
 * the signed-cheque lifecycle. claim signs nothing new on the swap — it files
 * output 0 (P2PKH sweep or token ingest) and only then retires the escrow.
 */
export const tokenSwapMachine = setup({
  types: { context: {} as Context, events: {} as Event },
  actions: {
    begin: assign(({ event }) => {
      if (
        event.type !== 'MAKE' &&
        event.type !== 'TAKE' &&
        event.type !== 'CLAIM' &&
        event.type !== 'CANCEL'
      ) {
        return {}
      }
      return {
        operation: OPERATION[event.type],
        path: event.path,
        reference: null,
        txid: null,
        error: event.path.path === 'refuse' ? event.path.reason : null,
      }
    }),
    reference: assign(({ event }) =>
      event.type === 'STAGED' ? { reference: event.reference } : {},
    ),
    txid: assign(({ event }) =>
      event.type === 'BROADCASTED' ? { txid: event.txid } : {},
    ),
    error: assign(({ event }) =>
      event.type === 'FAIL' || event.type === 'ABORTED' ? { error: event.error } : {},
    ),
  },
  guards: {
    refused: ({ context }) => context.path?.path === 'refuse',
    claiming: ({ context }) => context.operation === 'claim',
  },
}).createMachine({
  id: 'tokenSwap',
  initial: 'idle',
  context: {
    operation: null,
    path: null,
    reference: null,
    txid: null,
    error: null,
  },
  states: {
    idle: {
      on: {
        MAKE: { target: 'classifying', actions: 'begin' },
        TAKE: { target: 'classifying', actions: 'begin' },
        CLAIM: { target: 'classifying', actions: 'begin' },
        CANCEL: { target: 'classifying', actions: 'begin' },
      },
    },
    classifying: {
      always: [
        { guard: 'refused', target: 'failed' },
        { guard: 'claiming', target: 'ingesting' },
        { target: 'staging' },
      ],
    },
    staging: {
      on: {
        STAGED: { target: 'preSignAbortable', actions: 'reference' },
        FAIL: { target: 'failed', actions: 'error' },
      },
    },
    preSignAbortable: {
      on: {
        SIGNED_UNKNOWN: 'signedUnknown',
        ABORTED: { target: 'failed', actions: 'error' },
      },
    },
    signedUnknown: {
      on: {
        BROADCASTED: { target: 'broadcast', actions: 'txid' },
        ABORTED: { target: 'failed', actions: 'error' },
        RECOVER: 'recovery',
        FAIL: { target: 'recovery', actions: 'error' },
      },
    },
    broadcast: {
      on: { COMMITTED: 'committed', RECOVER: 'recovery', FAIL: { actions: 'error' } },
    },
    recovery: {
      on: {
        BROADCASTED: { target: 'broadcast', actions: 'txid' },
        COMMITTED: 'committed',
        ABORTED: { target: 'failed', actions: 'error' },
        FAIL: { actions: 'error' },
      },
    },
    ingesting: {
      on: {
        INGESTED: 'committed',
        FAIL: { target: 'failed', actions: 'error' },
      },
    },
    committed: { type: 'final' },
    failed: { type: 'final' },
  },
})

export type TokenSwapSnapshot = SnapshotFrom<typeof tokenSwapMachine>

/** Abort the noSend while no signed cheque reached the lifecycle. */
export function mayAbortTokenSwap(snapshot: TokenSwapSnapshot): boolean {
  return (
    snapshot.matches('preSignAbortable') ||
    snapshot.matches('signedUnknown') ||
    (snapshot.matches('recovery') &&
      !(typeof snapshot.context.txid === 'string' && /^[0-9a-f]{64}$/i.test(snapshot.context.txid)))
  )
}
