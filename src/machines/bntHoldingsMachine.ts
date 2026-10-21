import { and, assign, fromCallback, not, sendTo, setup, stateIn } from 'xstate'
import type { CacheCommand, CacheState, CacheUpdate } from '@aeon-ui/primitives'
import type { BntAssetSummary } from '../wallet/bnt/wallet'

type Context = {
  /** The open account and network the holdings are cached under. */
  key: string
  assets: BntAssetSummary[]
  /** The asset whose send form is open. */
  composing: string | null
  error: string | null
  /** Where the cached list stands; while `refreshing` the last list stays shown. */
  cache: CacheState
}

type Event =
  | { type: 'REFRESH'; key?: string }
  | { type: 'OPEN'; assetId: string }
  | { type: 'CLOSE' }
  | CacheUpdate<BntAssetSummary[], string>

const update = (event: Event) => (event.type === 'CACHE.UPDATE' ? event : null)
const refreshKey = (event: Event) => (event.type === 'REFRESH' ? (event.key ?? null) : null)

/**
 * BNT holdings shown beside 1Sat items and P2P-FT tokens. The list is only
 * what the wallet validated (`listBntAssets`), read through the shared
 * holdings cache, so a revisit shows it at once and activity revalidates it
 * in the background. REFRESH with another account's key moves to that
 * account's entry. Opening an asset's send form is a chart step, and the send
 * itself is the panel's async action, which re-reads outputs.
 */
export const bntHoldingsMachine = setup({
  types: { context: {} as Context, events: {} as Event, input: {} as { key: string } },
  actors: {
    holdings: fromCallback<CacheCommand<string>, { key: string }>(({ input, sendBack }) => {
      sendBack({
        type: 'CACHE.UPDATE',
        cache: 'bnt-holdings',
        key: input.key,
        view: { state: 'failed', data: undefined, error: 'bntHoldingsMachine.holdings is provided by the panel', loadedAt: null },
      } satisfies CacheUpdate<BntAssetSummary[], string>)
    }),
  },
  guards: {
    held: ({ context, event }) => event.type === 'OPEN' && context.assets.some((a) => a.assetId === event.assetId),
    otherKey: ({ context, event }) => update(event)?.key !== context.key,
    listed: ({ event }) => update(event)?.view.loadedAt != null,
    refused: ({ event }) => update(event)?.view.state === 'failed',
    composingHeld: ({ context, event }) => !!update(event)?.view.data?.some((a) => a.assetId === context.composing),
    newKey: ({ context, event }) => {
      const key = refreshKey(event)
      return key !== null && key !== context.key
    },
  },
  actions: {
    take: assign(({ event }) => {
      const view = update(event)!.view
      return { assets: view.data ?? [], error: view.error, cache: view.state }
    }),
    note: assign(({ event }) => ({ cache: update(event)!.view.state })),
  },
}).createMachine({
  id: 'bntHoldings',
  initial: 'loading',
  context: ({ input }) => ({ key: input.key, assets: [], composing: null, error: null, cache: 'idle' }),
  invoke: { id: 'holdings', src: 'holdings', input: ({ context }) => ({ key: context.key }) },
  on: {
    'CACHE.UPDATE': [
      { guard: 'otherKey' },
      { guard: and(['listed', stateIn({ ready: 'composing' }), not('composingHeld')]), target: '.ready.browsing', actions: ['take', assign({ composing: null })] },
      { guard: and(['listed', stateIn('ready')]), actions: 'take' },
      { guard: and(['listed', 'composingHeld']), target: '.ready.composing', actions: 'take' },
      { guard: 'listed', target: '.ready.browsing', actions: ['take', assign({ composing: null })] },
      { guard: 'refused', target: '.failed', actions: 'take' },
      { guard: stateIn('loading'), actions: 'note' },
      { target: '.loading', actions: ['take', assign({ composing: null })] },
    ],
    REFRESH: [
      {
        guard: 'newKey',
        target: '.loading',
        actions: [
          assign(({ context, event }) => ({ key: refreshKey(event) ?? context.key, assets: [], composing: null, error: null, cache: 'idle' as const })),
          sendTo('holdings', ({ context }) => ({ type: 'CACHE.KEY', key: context.key })),
        ],
      },
      { actions: sendTo('holdings', { type: 'CACHE.INVALIDATE' }) },
    ],
  },
  states: {
    loading: {
      on: { CLOSE: { actions: assign({ composing: null }) } },
    },
    ready: {
      initial: 'browsing',
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
    failed: {},
  },
})
