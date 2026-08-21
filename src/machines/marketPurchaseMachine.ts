import { assign, setup, type SnapshotFrom } from 'xstate'
import type { MarketPurchasePath } from '../wallet/marketSettlementPath'

export type MarketPurchaseContext = {
  listingKey: string
  path: MarketPurchasePath | null
  reference: string | null
  error: string | null
}

export type MarketPurchaseEvent =
  | { type: 'START'; listingKey: string; path: MarketPurchasePath }
  | { type: 'VERIFIED' }
  | { type: 'RESERVED'; reference: string }
  | { type: 'SELLER_SIGNED' }
  | { type: 'SIGNING' }
  | { type: 'BROADCASTED' }
  | { type: 'COMMITTED' }
  | { type: 'RECOVER' }
  | { type: 'TIMEOUT' }
  | { type: 'DUPLICATE' }
  | { type: 'COMPETING_BUYER' }
  | { type: 'ABORTED' }
  | { type: 'FAIL'; error: string }
  | { type: 'RESET' }

export const marketPurchaseMachine = setup({
  types: {
    context: {} as MarketPurchaseContext,
    events: {} as MarketPurchaseEvent,
  },
  actions: {
    begin: assign(({ event }) =>
      event.type === 'START'
        ? {
            listingKey: event.listingKey,
            path: event.path,
            reference: null,
            error:
              event.path.path === 'refuse' ? event.path.reason : null,
          }
        : {},
    ),
    rememberReference: assign(({ event }) =>
      event.type === 'RESERVED' ? { reference: event.reference } : {},
    ),
    setError: assign(({ event }) => {
      if (event.type === 'FAIL') return { error: event.error }
      if (event.type === 'TIMEOUT') return { error: 'timeout' }
      if (event.type === 'DUPLICATE') return { error: 'duplicate-request' }
      if (event.type === 'COMPETING_BUYER') return { error: 'competing-buyer' }
      return {}
    }),
    clear: assign({
      listingKey: '',
      path: null,
      reference: null,
      error: null,
    }),
  },
  guards: {
    refused: ({ context }) => context.path?.path === 'refuse',
  },
}).createMachine({
  id: 'marketPurchase',
  initial: 'idle',
  context: { listingKey: '', path: null, reference: null, error: null },
  states: {
    idle: { on: { START: { target: 'classifying', actions: 'begin' } } },
    classifying: {
      always: [
        { guard: 'refused', target: 'failed' },
        { target: 'verifying' },
      ],
    },
    verifying: {
      on: {
        VERIFIED: 'reserving',
        FAIL: { target: 'failed', actions: 'setError' },
      },
    },
    reserving: {
      on: {
        RESERVED: { target: 'preSignAbortable', actions: 'rememberReference' },
        FAIL: { target: 'failed', actions: 'setError' },
      },
    },
    preSignAbortable: {
      on: {
        SELLER_SIGNED: 'sellerSigned',
        TIMEOUT: { target: 'aborting', actions: 'setError' },
        DUPLICATE: { target: 'aborting', actions: 'setError' },
        COMPETING_BUYER: { target: 'aborting', actions: 'setError' },
        FAIL: { target: 'aborting', actions: 'setError' },
      },
    },
    sellerSigned: {
      on: {
        SIGNING: 'signedUnknown',
        TIMEOUT: { target: 'aborting', actions: 'setError' },
        FAIL: { target: 'aborting', actions: 'setError' },
      },
    },
    signedUnknown: {
      on: {
        BROADCASTED: 'broadcast',
        RECOVER: 'recovery',
        FAIL: { target: 'recovery', actions: 'setError' },
      },
    },
    broadcast: { on: { COMMITTED: 'committed', RECOVER: 'recovery' } },
    recovery: {
      on: {
        BROADCASTED: 'broadcast',
        COMMITTED: 'committed',
        FAIL: { actions: 'setError' },
      },
    },
    aborting: { on: { ABORTED: 'failed' } },
    committed: { on: { RESET: { target: 'idle', actions: 'clear' } } },
    failed: { on: { RESET: { target: 'idle', actions: 'clear' } } },
  },
})

export type MarketPurchaseSnapshot = SnapshotFrom<
  typeof marketPurchaseMachine
>

export function mayAbortMarketPurchase(
  snapshot: MarketPurchaseSnapshot,
): boolean {
  return (
    snapshot.matches('preSignAbortable') ||
    snapshot.matches('sellerSigned') ||
    snapshot.matches('aborting')
  )
}

export function mustAbortMarketPurchase(
  snapshot: MarketPurchaseSnapshot,
): boolean {
  return snapshot.matches('aborting')
}

export function mayBroadcastMarketPurchase(
  snapshot: MarketPurchaseSnapshot,
): boolean {
  return snapshot.matches('signedUnknown')
}
