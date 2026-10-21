import { and, assign, fromCallback, fromPromise, sendTo, setup, stateIn } from 'xstate'
import type { CacheCommand, CacheState, CacheUpdate } from '@aeon-ui/primitives'
import { offerRoom, type SignedSwapOffer } from '../wallet/swap/offer'
import type { OfferBookPage } from '../wallet/swap/offerBook'
import { previewTake } from '../wallet/swap/settle'

type Context = {
  /** This wallet's identity key: its offers are the ones it may cancel, and the ones it may not take. */
  self: string | null
  /** The open account and network the book is cached under. */
  key: string
  /** Where the cached book stands; while `refreshing` the last book stays shown. */
  cache: CacheState
  /** The cached book the offers came from; the cache keeps its identity until the next load, which load times can't tell apart. */
  book: OfferBookPage | null
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
  | CacheUpdate<OfferBookPage, string>

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

const update = (event: Event) => (event.type === 'CACHE.UPDATE' ? event : null)

/**
 * Browsing the swap offer book (Swap › Offers). Every listed offer is
 * verified in the wallet before it reaches `ready`. The book is read through
 * the shared offer book cache, so reopening Offers shows it at once; REFRESH,
 * a cancel or a take revalidates it while the last book stays shown. CANCEL
 * withdraws one of this wallet's own offers (it signs the withdrawal).
 * REVIEW shows what taking someone else's offer locks and returns, all of
 * what is left of it by default; AMOUNT picks a part of an offer that can be
 * filled in parts. Only CONFIRM sends the take, and only for an amount that
 * fits. The wallet then locks its side at once (`swapSettleMachine`); the
 * maker locks when it next comes online, and both sides complete or both are
 * refunded.
 */
export const swapOffersMachine = setup({
  types: { context: {} as Context, events: {} as Event, input: {} as { self: string | null; key: string } },
  actors: {
    book: fromCallback<CacheCommand<string>, { key: string }>(({ input, sendBack }) => {
      sendBack({
        type: 'CACHE.UPDATE',
        cache: 'swap-offer-book',
        key: input.key,
        view: { state: 'failed', data: undefined, error: 'offer book loading is not provided', loadedAt: null },
      } satisfies CacheUpdate<OfferBookPage, string>)
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
    otherKey: ({ context, event }) => update(event)?.key !== context.key,
    listed: ({ event }) => update(event)?.view.loadedAt != null,
    newBook: ({ context, event }) => update(event)?.view.data !== context.book,
    refused: ({ event }) => update(event)?.view.state === 'failed',
  },
  actions: {
    take: assign(({ event }) => {
      const view = update(event)!.view
      return { offers: view.data!.offers, filled: view.data!.filled, book: view.data!, cache: view.state }
    }),
    note: assign(({ event }) => ({ cache: update(event)!.view.state })),
    revalidate: sendTo('book', { type: 'CACHE.INVALIDATE' }),
  },
}).createMachine({
  id: 'swapOffers',
  initial: 'loading',
  context: ({ input }) => ({
    self: input.self,
    key: input.key,
    cache: 'idle',
    book: null,
    offers: [],
    filled: new Map(),
    pay: null,
    cancelling: null,
    taking: null,
    failure: null,
  }),
  invoke: { id: 'book', src: 'book', input: ({ context }) => ({ key: context.key }) },
  on: {
    'CACHE.UPDATE': [
      { guard: 'otherKey' },
      { guard: and(['listed', stateIn('loading')]), target: '.ready', actions: ['take', assign({ failure: null })] },
      { guard: and(['listed', stateIn('failed')]), target: '.ready', actions: ['take', assign({ failure: null })] },
      { guard: and(['listed', 'newBook']), actions: 'take' },
      { guard: 'listed', actions: 'note' },
      { guard: 'refused', target: '.failed', actions: ['note', assign(({ event }) => ({ failure: update(event)!.view.error }))] },
      { guard: stateIn('failed'), target: '.loading', actions: 'note' },
      { actions: 'note' },
    ],
  },
  states: {
    loading: {},
    ready: {
      on: {
        REFRESH: { actions: 'revalidate' },
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
        onDone: {
          target: 'ready',
          actions: [assign(({ context }) => ({ offers: context.offers.filter((o) => o.nonce !== context.cancelling), cancelling: null })), 'revalidate'],
        },
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
        onDone: { target: 'taken', actions: 'revalidate' },
        onError: { target: 'reviewing', actions: assign(({ event }) => ({ failure: message(event.error) })) },
      },
    },
    taken: { on: { REFRESH: { target: 'ready', actions: [assign({ taking: null, pay: null }), 'revalidate'] } } },
    failed: { on: { REFRESH: { actions: 'revalidate' } } },
  },
})
