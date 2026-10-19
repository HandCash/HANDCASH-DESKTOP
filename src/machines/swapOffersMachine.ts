import { and, assign, fromPromise, setup } from 'xstate'
import { offerRoom, type SignedSwapOffer } from '../wallet/swap/offer'
import type { OfferBookPage } from '../wallet/swap/offerBook'
import { previewTake } from '../wallet/swap/settle'

type Context = {
  /** This wallet's identity key: its offers are the ones it may cancel, and the ones it may not take. */
  self: string | null
  offers: SignedSwapOffer[]
  /** What the book says is taken of each part-fillable offer, by nonce. */
  filled: ReadonlyMap<string, bigint>
  /** How much of the reviewed offer's `get` to pay: all that is left unless the taker chose a part. */
  pay: bigint | null
  /** The offer being withdrawn. */
  cancelling: string | null
  /** The offer under review, then being taken. */
  taking: string | null
  failure: string | null
}

type Event =
  | { type: 'REFRESH' }
  | { type: 'CANCEL'; nonce: string }
  | { type: 'REVIEW'; nonce: string }
  | { type: 'AMOUNT'; pay: bigint | null }
  | { type: 'BACK' }
  | { type: 'CONFIRM' }

export type TakeInput = { offer: SignedSwapOffer; pay: bigint }

/** What is left of `offer` to take, by the book. */
export const roomOf = (context: Pick<Context, 'filled'>, offer: SignedSwapOffer) => offerRoom(offer, context.filled.get(offer.nonce) ?? 0n)

const reviewed = (context: Context) => context.offers.find((o) => o.nonce === context.taking) ?? null

/** The amount chosen for the reviewed offer fits what is left of it and leaves the taker something after its claim. */
export function amountFits(context: Context): boolean {
  const offer = reviewed(context)
  const room = offer ? roomOf(context, offer) : null
  return !!offer && !!room && context.pay !== null && context.pay >= room.min && context.pay <= room.max && previewTake(offer, context.pay) !== null
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Browsing the swap offer book (Swap › Offers). Every listed offer is
 * verified in the wallet before it reaches `ready`. CANCEL withdraws one of
 * this wallet's own offers (it signs the withdrawal) and reloads the book.
 * REVIEW shows what taking someone else's offer locks and returns, all of
 * what is left of it by default; AMOUNT picks a part of an offer that can be
 * filled in parts. Only CONFIRM sends the take, and only for an amount that
 * fits. The wallet then locks its side at once (`swapSettleMachine`); the
 * maker locks when it next comes online, and both sides complete or both are
 * refunded.
 */
export const swapOffersMachine = setup({
  types: { context: {} as Context, events: {} as Event, input: {} as { self: string | null } },
  actors: {
    load: fromPromise<OfferBookPage, void>(async () => {
      throw new Error('offer book loading is not provided')
    }),
    cancel: fromPromise<void, string>(async () => {
      throw new Error('offer cancelling is not provided')
    }),
    take: fromPromise<void, TakeInput>(async () => {
      throw new Error('offer taking is not provided')
    }),
  },
  guards: {
    own: ({ context, event }) =>
      event.type === 'CANCEL' && !!context.self && context.offers.some((o) => o.nonce === event.nonce && o.maker === context.self),
    takeable: ({ context, event }) =>
      event.type === 'REVIEW' && !!context.self && context.offers.some((o) => o.nonce === event.nonce && o.maker !== context.self && o.expiresAt > Date.now()),
    stillListed: ({ context }) => context.offers.some((o) => o.nonce === context.taking && o.expiresAt > Date.now()),
    amountFits: ({ context }) => amountFits(context),
  },
}).createMachine({
  id: 'swapOffers',
  initial: 'loading',
  context: ({ input }) => ({ self: input.self, offers: [], filled: new Map(), pay: null, cancelling: null, taking: null, failure: null }),
  states: {
    loading: {
      invoke: {
        src: 'load',
        onDone: { target: 'ready', actions: assign(({ event }) => ({ offers: event.output.offers, filled: event.output.filled, failure: null })) },
        onError: { target: 'failed', actions: assign(({ event }) => ({ failure: message(event.error) })) },
      },
    },
    ready: {
      on: {
        REFRESH: 'loading',
        CANCEL: { guard: 'own', target: 'cancelling', actions: assign(({ event }) => ({ cancelling: event.nonce, failure: null })) },
        REVIEW: {
          guard: 'takeable',
          target: 'reviewing',
          actions: assign(({ context, event }) => {
            const offer = context.offers.find((o) => o.nonce === event.nonce)
            return { taking: event.nonce, pay: offer ? (roomOf(context, offer)?.max ?? null) : null, failure: null }
          }),
        },
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
        AMOUNT: { actions: assign(({ event }) => ({ pay: event.pay, failure: null })) },
        BACK: { target: 'ready', actions: assign({ taking: null, pay: null }) },
        CONFIRM: [
          { guard: and(['stillListed', 'amountFits']), target: 'taking' },
          { guard: 'stillListed' },
          { target: 'ready', actions: assign({ taking: null, pay: null, failure: 'This offer has expired.' }) },
        ],
      },
    },
    taking: {
      invoke: {
        src: 'take',
        input: ({ context }) => ({ offer: reviewed(context) as SignedSwapOffer, pay: context.pay as bigint }),
        onDone: { target: 'taken' },
        onError: { target: 'reviewing', actions: assign(({ event }) => ({ failure: message(event.error) })) },
      },
    },
    taken: { on: { REFRESH: { target: 'loading', actions: assign({ taking: null, pay: null }) } } },
    failed: { on: { REFRESH: 'loading' } },
  },
})
