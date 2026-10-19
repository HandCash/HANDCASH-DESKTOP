import { assign, fromPromise, setup } from 'xstate'
import type { SignedSwapOffer } from '../wallet/swap/offer'

type Context = {
  /** This wallet's identity key: its offers are the ones it may cancel, and the ones it may not take. */
  self: string | null
  offers: SignedSwapOffer[]
  /** The offer being withdrawn. */
  cancelling: string | null
  /** The offer under review, then being taken. */
  taking: string | null
  failure: string | null
}

type Event = { type: 'REFRESH' } | { type: 'CANCEL'; nonce: string } | { type: 'REVIEW'; nonce: string } | { type: 'BACK' } | { type: 'CONFIRM' }

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Browsing the swap offer book (Swap › Offers). Every listed offer is
 * verified in the wallet before it reaches `ready`. CANCEL withdraws one of
 * this wallet's own offers (it signs the withdrawal) and reloads the book.
 * REVIEW shows what taking someone else's offer locks and returns; only
 * CONFIRM sends the take. The take itself moves no coin: the wallet locks its
 * side once the maker accepts (`swapSettleMachine`), and both sides complete
 * or both are refunded.
 */
export const swapOffersMachine = setup({
  types: { context: {} as Context, events: {} as Event, input: {} as { self: string | null } },
  actors: {
    load: fromPromise<SignedSwapOffer[], void>(async () => {
      throw new Error('offer book loading is not provided')
    }),
    cancel: fromPromise<void, string>(async () => {
      throw new Error('offer cancelling is not provided')
    }),
    take: fromPromise<void, SignedSwapOffer>(async () => {
      throw new Error('offer taking is not provided')
    }),
  },
  guards: {
    own: ({ context, event }) =>
      event.type === 'CANCEL' && !!context.self && context.offers.some((o) => o.nonce === event.nonce && o.maker === context.self),
    takeable: ({ context, event }) =>
      event.type === 'REVIEW' && !!context.self && context.offers.some((o) => o.nonce === event.nonce && o.maker !== context.self && o.expiresAt > Date.now()),
    stillListed: ({ context }) => context.offers.some((o) => o.nonce === context.taking && o.expiresAt > Date.now()),
  },
}).createMachine({
  id: 'swapOffers',
  initial: 'loading',
  context: ({ input }) => ({ self: input.self, offers: [], cancelling: null, taking: null, failure: null }),
  states: {
    loading: {
      invoke: {
        src: 'load',
        onDone: { target: 'ready', actions: assign(({ event }) => ({ offers: event.output, failure: null })) },
        onError: { target: 'failed', actions: assign(({ event }) => ({ failure: message(event.error) })) },
      },
    },
    ready: {
      on: {
        REFRESH: 'loading',
        CANCEL: { guard: 'own', target: 'cancelling', actions: assign(({ event }) => ({ cancelling: event.nonce, failure: null })) },
        REVIEW: { guard: 'takeable', target: 'reviewing', actions: assign(({ event }) => ({ taking: event.nonce, failure: null })) },
      },
    },
    cancelling: {
      invoke: {
        src: 'cancel',
        input: ({ context }) => context.cancelling as string,
        onDone: { target: 'loading', actions: assign({ cancelling: null }) },
        onError: { target: 'ready', actions: assign(({ event }) => ({ cancelling: null, failure: message(event.error) })) },
      },
    },
    reviewing: {
      on: {
        BACK: { target: 'ready', actions: assign({ taking: null }) },
        CONFIRM: [
          { guard: 'stillListed', target: 'taking' },
          { target: 'ready', actions: assign({ taking: null, failure: 'This offer has expired.' }) },
        ],
      },
    },
    taking: {
      invoke: {
        src: 'take',
        input: ({ context }) => context.offers.find((o) => o.nonce === context.taking) as SignedSwapOffer,
        onDone: { target: 'taken' },
        onError: { target: 'reviewing', actions: assign(({ event }) => ({ failure: message(event.error) })) },
      },
    },
    taken: { on: { REFRESH: { target: 'loading', actions: assign({ taking: null }) } } },
    failed: { on: { REFRESH: 'loading' } },
  },
})
