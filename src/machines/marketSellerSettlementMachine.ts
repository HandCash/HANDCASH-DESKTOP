import { assign, setup, type SnapshotFrom } from 'xstate'
import type { MarketSellerSettlePath } from '../wallet/marketSettlementPath'

export type MarketSellerSettlementContext = {
  listingKey: string
  buyerIdentityKey: string
  path: MarketSellerSettlePath | null
  error: string | null
}

export type MarketSellerSettlementEvent =
  | {
      type: 'START'
      listingKey: string
      buyerIdentityKey: string
      path: MarketSellerSettlePath
    }
  | { type: 'VALIDATED' }
  | { type: 'ITEM_INPUT_SIGNED' }
  | { type: 'DELIVERED' }
  | { type: 'BROADCAST_CONFIRMED' }
  | { type: 'TIMEOUT' }
  | { type: 'DUPLICATE' }
  | { type: 'COMPETING_BUYER' }
  | { type: 'FAIL'; error: string }
  | { type: 'RESET' }

export const marketSellerSettlementMachine = setup({
  types: {
    context: {} as MarketSellerSettlementContext,
    events: {} as MarketSellerSettlementEvent,
  },
  actions: {
    begin: assign(({ event }) =>
      event.type === 'START'
        ? {
            listingKey: event.listingKey,
            buyerIdentityKey: event.buyerIdentityKey,
            path: event.path,
            error:
              event.path.settle === 'refuse' ? event.path.reason : null,
          }
        : {},
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
      buyerIdentityKey: '',
      path: null,
      error: null,
    }),
  },
  guards: {
    refused: ({ context }) => context.path?.settle === 'refuse',
  },
}).createMachine({
  id: 'marketSellerSettlement',
  initial: 'idle',
  context: {
    listingKey: '',
    buyerIdentityKey: '',
    path: null,
    error: null,
  },
  states: {
    idle: { on: { START: { target: 'classifying', actions: 'begin' } } },
    classifying: {
      always: [
        { guard: 'refused', target: 'refused' },
        { target: 'validating' },
      ],
    },
    validating: {
      on: {
        VALIDATED: 'signingItemInput',
        DUPLICATE: { target: 'refused', actions: 'setError' },
        COMPETING_BUYER: { target: 'refused', actions: 'setError' },
        TIMEOUT: { target: 'refused', actions: 'setError' },
        FAIL: { target: 'refused', actions: 'setError' },
      },
    },
    signingItemInput: {
      on: {
        ITEM_INPUT_SIGNED: 'peerDeliver',
        TIMEOUT: { target: 'refused', actions: 'setError' },
        FAIL: { target: 'refused', actions: 'setError' },
      },
    },
    peerDeliver: {
      on: {
        DELIVERED: 'awaitingBroadcast',
        TIMEOUT: { target: 'refused', actions: 'setError' },
        FAIL: { target: 'refused', actions: 'setError' },
      },
    },
    awaitingBroadcast: {
      on: {
        BROADCAST_CONFIRMED: 'settled',
        TIMEOUT: { target: 'refused', actions: 'setError' },
        FAIL: { target: 'refused', actions: 'setError' },
      },
    },
    settled: { on: { RESET: { target: 'idle', actions: 'clear' } } },
    refused: { on: { RESET: { target: 'idle', actions: 'clear' } } },
  },
})

export type MarketSellerSettlementSnapshot = SnapshotFrom<
  typeof marketSellerSettlementMachine
>

/** Seller never broadcasts while delivering its one-input signature. */
export function sellerMayConfirmBroadcast(
  snapshot: MarketSellerSettlementSnapshot,
): boolean {
  return snapshot.matches('awaitingBroadcast')
}
