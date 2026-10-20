import { assign, fromPromise, setup } from 'xstate'
import type { BntAssetSummary } from '../wallet/bnt/wallet'

type Context = {
  assets: BntAssetSummary[]
  /** The asset whose send form is open. */
  composing: string | null
  error: string | null
}

type Event =
  | { type: 'REFRESH' }
  | { type: 'OPEN'; assetId: string }
  | { type: 'CLOSE' }

/**
 * BNT holdings shown beside 1Sat items and P2P-FT tokens. The list is only
 * what the wallet validated (`listBntAssets`); opening an asset's send form
 * is a chart step, and the send itself is the panel's async action.
 */
export const bntHoldingsMachine = setup({
  types: { context: {} as Context, events: {} as Event },
  actors: {
    load: fromPromise<BntAssetSummary[]>(async () => {
      throw new Error('bntHoldingsMachine.load is provided by the panel')
    }),
  },
  guards: {
    held: ({ context, event }) => event.type === 'OPEN' && context.assets.some((a) => a.assetId === event.assetId),
  },
}).createMachine({
  id: 'bntHoldings',
  initial: 'loading',
  context: { assets: [], composing: null, error: null },
  states: {
    loading: {
      on: {
        REFRESH: { target: 'loading', reenter: true },
        CLOSE: { actions: assign({ composing: null }) },
      },
      invoke: {
        src: 'load',
        onDone: [
          {
            guard: ({ context, event }) => event.output.some((a) => a.assetId === context.composing),
            target: 'ready.composing',
            actions: assign(({ event }) => ({ assets: event.output, error: null })),
          },
          {
            target: 'ready.browsing',
            actions: assign(({ event }) => ({ assets: event.output, error: null, composing: null })),
          },
        ],
        onError: {
          target: 'failed',
          actions: assign(({ event }) => ({ error: event.error instanceof Error ? event.error.message : String(event.error) })),
        },
      },
    },
    ready: {
      initial: 'browsing',
      on: { REFRESH: '#bntHoldings.loading' },
      states: {
        browsing: {
          on: { OPEN: { guard: 'held', target: 'composing', actions: assign(({ event }) => ({ composing: event.assetId })) } },
        },
        composing: {
          on: {
            OPEN: { guard: 'held', actions: assign(({ event }) => ({ composing: event.assetId })) },
            CLOSE: { target: 'browsing', actions: assign({ composing: null }) },
          },
        },
      },
    },
    failed: { on: { REFRESH: 'loading' } },
  },
})
