import { assign, fromPromise, setup } from 'xstate'
import type { SwapRequest, SwapRoute } from '../wallet/swap/routing'
import { SWAP_QUOTE_TTL_MS, type SwapQuote, type SwapQuoteRefusal } from '../wallet/swap/quote'
import type { SwapStart } from '../wallet/swap/runSwap'
import type { SignedSwapOffer } from '../wallet/swap/offer'
import type { SwapOfferDraft } from '../wallet/swap/offerBook'

type QuoteResult = { ok: true; quote: SwapQuote } | { ok: false; refusal: SwapQuoteRefusal }

export type SwapFailure = { reason: string; message: string }

type Context = {
  request: SwapRequest | null
  quote: SwapQuote | null
  /** Index into `quote.routes`; the default route is 0. */
  picked: number
  refusal: SwapQuoteRefusal | { kind: 'failed'; detail: string } | null
  /** What CONFIRM started: an Exolix exchange, or the take of a direct offer. */
  started: SwapStart | null
  failure: SwapFailure | null
  /** The offer under review when no route can take the swap. */
  draft: SwapOfferDraft | null
  published: SignedSwapOffer | null
}

type Event =
  | { type: 'QUOTE'; request: SwapRequest }
  | { type: 'PICK'; index: number }
  | { type: 'REVIEW' }
  | { type: 'BACK' }
  | { type: 'CONFIRM' }
  | { type: 'RESET' }
  | { type: 'OFFER'; draft: SwapOfferDraft }
  | { type: 'PARTS'; allow: boolean }
  | { type: 'PUBLISH' }

const routeOf = (context: Context): SwapRoute | null => context.quote?.routes[context.picked] ?? null

/**
 * A swap between coins this wallet holds (Swap, between Send and Receive).
 *
 * QUOTE asks for every route at once: direct offers, each verified, and
 * Exolix's fixed rate. The ranked routes are `quoted` with the default
 * picked: the best direct offer when it pays at least what Exolix pays,
 * otherwise Exolix. PICK chooses another route; a quote goes `stale` after
 * its time. REVIEW shows exactly what is paid and received, the fee, and who
 * holds the coins; only CONFIRM there runs the swap. Nothing moves before
 * CONFIRM. A direct route's CONFIRM sends the take: the wallet locks once the
 * maker accepts (`swapSettleMachine`), and nobody holds the coins.
 *
 * When no route can take the swap (under Exolix's minimum, say), OFFER opens
 * a standing offer at the market rate for review; PARTS lets takers each
 * fill a part of it (down to the draft's smallest part) or only all of it;
 * only PUBLISH there signs it and posts it to the offer book. Publishing
 * moves no coin.
 */
export const swapMachine = setup({
  types: { context: {} as Context, events: {} as Event },
  actors: {
    quote: fromPromise<QuoteResult, SwapRequest>(async () => {
      throw new Error('swap quoting is not provided')
    }),
    execute: fromPromise<SwapStart, SwapRoute>(async () => {
      throw new Error('swap execution is not provided')
    }),
    publish: fromPromise<SignedSwapOffer, SwapOfferDraft>(async () => {
      throw new Error('offer publishing is not provided')
    }),
  },
  actions: {
    request: assign(({ event }) => (event.type === 'QUOTE' ? { request: event.request, quote: null, picked: 0, refusal: null, failure: null } : {})),
    clear: assign({ request: null, quote: null, picked: 0, refusal: null, started: null, failure: null, draft: null, published: null }),
  },
  guards: {
    quoted: (_, result: QuoteResult) => result.ok,
    pickable: ({ context, event }) =>
      event.type === 'PICK' && Number.isInteger(event.index) && event.index >= 0 && event.index < (context.quote?.routes.length ?? 0),
    executable: ({ context }) => routeOf(context) !== null,
    offerable: ({ context, event }) => event.type === 'OFFER' && context.refusal?.kind === 'no-route',
    splittable: ({ context }) => !!context.draft && context.draft.partWant < context.draft.want,
  },
  delays: { quoteTtl: SWAP_QUOTE_TTL_MS },
}).createMachine({
  id: 'swap',
  initial: 'editing',
  context: { request: null, quote: null, picked: 0, refusal: null, started: null, failure: null, draft: null, published: null },
  states: {
    editing: {
      on: { QUOTE: { target: 'quoting', actions: 'request' } },
    },
    quoting: {
      on: { QUOTE: { target: 'quoting', reenter: true, actions: 'request' } },
      invoke: {
        src: 'quote',
        input: ({ context }) => context.request as SwapRequest,
        onDone: [
          {
            guard: { type: 'quoted', params: ({ event }) => event.output },
            target: 'quoted',
            actions: assign(({ event }) => (event.output.ok ? { quote: event.output.quote, picked: 0 } : {})),
          },
          { target: 'refused', actions: assign(({ event }) => (event.output.ok ? {} : { refusal: event.output.refusal })) },
        ],
        onError: {
          target: 'refused',
          actions: assign(({ event }) => ({ refusal: { kind: 'failed' as const, detail: event.error instanceof Error ? event.error.message : String(event.error) } })),
        },
      },
    },
    quoted: {
      after: { quoteTtl: 'stale' },
      on: {
        QUOTE: { target: 'quoting', actions: 'request' },
        PICK: { guard: 'pickable', actions: assign(({ event }) => ({ picked: event.index })) },
        REVIEW: { guard: 'executable', target: 'reviewing' },
      },
    },
    reviewing: {
      after: { quoteTtl: 'stale' },
      on: {
        BACK: 'quoted',
        CONFIRM: 'swapping',
      },
    },
    swapping: {
      invoke: {
        src: 'execute',
        input: ({ context }) => routeOf(context) as SwapRoute,
        onDone: { target: 'done', actions: assign(({ event }) => ({ started: event.output })) },
        onError: {
          target: 'failed',
          actions: assign(({ event }) => {
            const err = event.error as { reason?: unknown; message?: unknown } | null
            return {
              failure: {
                reason: typeof err?.reason === 'string' ? err.reason : 'failed',
                message: typeof err?.message === 'string' ? err.message : String(event.error),
              },
            }
          }),
        },
      },
    },
    stale: { on: { QUOTE: { target: 'quoting', actions: 'request' } } },
    refused: {
      on: {
        QUOTE: { target: 'quoting', actions: 'request' },
        OFFER: { guard: 'offerable', target: 'offering', actions: assign(({ event }) => ({ draft: event.draft, failure: null })) },
      },
    },
    offering: {
      on: {
        PARTS: {
          guard: 'splittable',
          actions: assign(({ context, event }) => ({ draft: { ...context.draft!, minWant: event.allow ? context.draft!.partWant : context.draft!.want } })),
        },
        PUBLISH: 'publishing',
        BACK: { target: 'refused', actions: assign({ draft: null, failure: null }) },
        QUOTE: { target: 'quoting', actions: ['request', assign({ draft: null })] },
      },
    },
    publishing: {
      invoke: {
        src: 'publish',
        input: ({ context }) => context.draft as SwapOfferDraft,
        onDone: { target: 'published', actions: assign(({ event }) => ({ published: event.output, failure: null })) },
        onError: {
          target: 'offering',
          actions: assign(({ event }) => ({
            failure: { reason: 'publish-failed', message: event.error instanceof Error ? event.error.message : String(event.error) },
          })),
        },
      },
    },
    published: { on: { RESET: { target: 'editing', actions: 'clear' } } },
    done: { on: { RESET: { target: 'editing', actions: 'clear' } } },
    failed: { on: { RESET: { target: 'editing', actions: 'clear' } } },
  },
})
