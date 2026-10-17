import { assign, setup, type SnapshotFrom } from 'xstate'
import type {
  DirectOfferBuyPath,
  DirectOfferCancelPath,
  DirectOfferCollectPath,
  DirectOfferListPath,
} from '../wallet/directOfferPath'
import type { MarketCancelPath, MarketListingPath } from '../wallet/marketListingPath'
import type { OfferOperation, OfferVenue } from '../wallet/offerTerms'

type OfferPath =
  | MarketListingPath
  | MarketCancelPath
  | DirectOfferListPath
  | DirectOfferBuyPath
  | DirectOfferCollectPath
  | DirectOfferCancelPath

type Context = {
  venue: OfferVenue | null
  operation: OfferOperation | null
  path: OfferPath | null
  reference: string | null
  txid: string | null
  error: string | null
}

type Event =
  | { type: 'LIST'; venue: 'market'; path: MarketListingPath }
  | { type: 'LIST'; venue: 'direct'; path: DirectOfferListPath }
  | { type: 'CANCEL'; venue: 'market'; path: MarketCancelPath }
  | { type: 'CANCEL'; venue: 'direct'; path: DirectOfferCancelPath }
  | { type: 'BUY'; venue: 'direct'; path: DirectOfferBuyPath }
  | { type: 'COLLECT'; venue: 'direct'; path: DirectOfferCollectPath }
  | { type: 'STAGED'; reference: string }
  | { type: 'SIGNED_UNKNOWN' }
  | { type: 'BROADCASTED'; txid: string }
  | { type: 'COLLECTED' }
  | { type: 'COMMITTED' }
  | { type: 'RECOVER' }
  | { type: 'ABORTED'; error: string }
  | { type: 'FAIL'; error: string }

const OPERATION = {
  LIST: 'list',
  BUY: 'buy',
  COLLECT: 'collect',
  CANCEL: 'cancel',
} as const satisfies Record<string, OfferOperation>

/**
 * One offer operation, market or direct. list / cancel / buy each sign one
 * noSend transaction and share the signed-cheque lifecycle: abort and restore
 * the lot until the cheque is registered, never after BROADCASTED. collect
 * signs nothing on the offer; it files what the buyer paid and only then
 * retires the listed lot. A market purchase runs in `marketPurchaseMachine`
 * (overlay hydrate and seller receipt); a direct purchase runs here.
 */
export const offerMachine = setup({
  types: { context: {} as Context, events: {} as Event },
  actions: {
    begin: assign(({ event }) => {
      if (
        event.type !== 'LIST' &&
        event.type !== 'BUY' &&
        event.type !== 'COLLECT' &&
        event.type !== 'CANCEL'
      ) {
        return {}
      }
      return {
        venue: event.venue,
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
    collecting: ({ context }) => context.operation === 'collect',
  },
}).createMachine({
  id: 'offer',
  initial: 'idle',
  context: {
    venue: null,
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
        BUY: { target: 'classifying', actions: 'begin' },
        COLLECT: { target: 'classifying', actions: 'begin' },
        CANCEL: { target: 'classifying', actions: 'begin' },
      },
    },
    classifying: {
      always: [
        { guard: 'refused', target: 'failed' },
        { guard: 'collecting', target: 'collecting' },
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
        // The cheque never became durable — abort the noSend and free the lot.
        // Miners run after BROADCASTED and never send this.
        ABORTED: { target: 'failed', actions: 'error' },
        RECOVER: 'recovery',
        FAIL: { target: 'recovery', actions: 'error' },
      },
    },
    broadcast: { on: { COMMITTED: 'committed', RECOVER: 'recovery', FAIL: { actions: 'error' } } },
    recovery: {
      on: {
        BROADCASTED: { target: 'broadcast', actions: 'txid' },
        COMMITTED: 'committed',
        // Still abortable when Arcade never set BROADCASTED (no context.txid).
        ABORTED: { target: 'failed', actions: 'error' },
        FAIL: { actions: 'error' },
      },
    },
    collecting: {
      on: {
        COLLECTED: 'committed',
        FAIL: { target: 'failed', actions: 'error' },
      },
    },
    committed: { type: 'final' },
    failed: { type: 'final' },
  },
})

export type OfferSnapshot = SnapshotFrom<typeof offerMachine>

/**
 * Abort the noSend while Arcade has not accepted it.
 * After SIGNED_UNKNOWN a hard-reject used to skip abort (only preSignAbortable
 * was allowed), leaving the lot reserved → ITEM_NOT_HELD on every retry.
 */
export function mayAbortOffer(snapshot: OfferSnapshot): boolean {
  return (
    snapshot.matches('preSignAbortable') ||
    snapshot.matches('signedUnknown') ||
    (snapshot.matches('recovery') &&
      !(
        typeof snapshot.context.txid === 'string' &&
        /^[0-9a-f]{64}$/i.test(snapshot.context.txid)
      ))
  )
}
