import { assign, setup, type SnapshotFrom } from 'xstate'
import type { MarketCancelPath, MarketListingPath } from '../wallet/marketListingPath'

type Context = {
  operation: 'list' | 'cancel' | null
  path: MarketListingPath | MarketCancelPath | null
  reference: string | null
  txid: string | null
  error: string | null
}

type Event =
  | { type: 'LIST'; path: MarketListingPath }
  | { type: 'CANCEL'; path: MarketCancelPath }
  | { type: 'STAGED'; reference: string }
  | { type: 'SIGNED_UNKNOWN' }
  | { type: 'BROADCASTED'; txid: string }
  | { type: 'COMMITTED' }
  | { type: 'RECOVER' }
  | { type: 'ABORTED'; error: string }
  | { type: 'FAIL'; error: string }

export const marketListingMachine = setup({
  types: { context: {} as Context, events: {} as Event },
  actions: {
    begin: assign(({ event }) => {
      if (event.type !== 'LIST' && event.type !== 'CANCEL') return {}
      return {
        operation: event.type === 'LIST' ? ('list' as const) : ('cancel' as const),
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
      event.type === 'FAIL' || event.type === 'ABORTED'
        ? { error: event.error }
        : {},
    ),
  },
  guards: {
    refused: ({ context }) => context.path?.path === 'refuse',
  },
}).createMachine({
  id: 'marketListing',
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
        LIST: { target: 'classifying', actions: 'begin' },
        CANCEL: { target: 'classifying', actions: 'begin' },
      },
    },
    classifying: {
      always: [
        { guard: 'refused', target: 'failed' },
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
        RECOVER: 'recovery',
        FAIL: { target: 'recovery', actions: 'error' },
      },
    },
    broadcast: { on: { COMMITTED: 'committed', RECOVER: 'recovery' } },
    recovery: {
      on: {
        BROADCASTED: { target: 'broadcast', actions: 'txid' },
        COMMITTED: 'committed',
        FAIL: { actions: 'error' },
      },
    },
    committed: { type: 'final' },
    failed: { type: 'final' },
  },
})

export type MarketListingSnapshot = SnapshotFrom<typeof marketListingMachine>

export function mayAbortMarketListing(snapshot: MarketListingSnapshot): boolean {
  return snapshot.matches('preSignAbortable')
}
