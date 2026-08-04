import { assign, setup } from 'xstate'

export const STICKY_BAR_STATES = ['floating', 'docked', 'collapsed', 'hidden'] as const
export type StickyBarState = (typeof STICKY_BAR_STATES)[number]

export interface StickyBarContext {
  /** CSS inset for stacked sticky chrome (e.g. under a fixed site header). */
  offsetPx: number
  /** Resolved once on start from input.initial. */
  initial: StickyBarState
}

export type StickyBarEvent =
  | { type: 'DOCK' }
  | { type: 'FLOAT' }
  | { type: 'COLLAPSE' }
  | { type: 'EXPAND' }
  | { type: 'HIDE' }
  | { type: 'SHOW' }
  | { type: 'SET_OFFSET'; offsetPx: number }

/**
 * Sticky / fixed chrome band — site header, subnav, reveal trays.
 * Reference: items-market NavigationBar shrink, MarketNavbar sticky stack, BalanceStickyTray.
 *
 * States: floating | docked | collapsed | hidden
 */
export const stickyBarMachine = setup({
  types: {
    context: {} as StickyBarContext,
    events: {} as StickyBarEvent,
    input: {} as Partial<StickyBarContext>,
  },
  actions: {
    setOffset: assign({
      offsetPx: ({ event }) => (event.type === 'SET_OFFSET' ? event.offsetPx : 0),
    }),
  },
}).createMachine({
  id: 'stickyBar',
  context: ({ input }) => ({
    offsetPx: input?.offsetPx ?? 0,
    initial: input?.initial ?? 'floating',
  }),
  initial: 'resolve',
  states: {
    resolve: {
      always: [
        { target: 'docked', guard: ({ context }) => context.initial === 'docked' },
        { target: 'collapsed', guard: ({ context }) => context.initial === 'collapsed' },
        { target: 'hidden', guard: ({ context }) => context.initial === 'hidden' },
        { target: 'floating' },
      ],
    },
    floating: {
      on: {
        DOCK: 'docked',
        COLLAPSE: 'collapsed',
        HIDE: 'hidden',
        SET_OFFSET: { actions: 'setOffset' },
      },
    },
    docked: {
      on: {
        FLOAT: 'floating',
        COLLAPSE: 'collapsed',
        HIDE: 'hidden',
        SET_OFFSET: { actions: 'setOffset' },
      },
    },
    collapsed: {
      on: {
        EXPAND: 'floating',
        DOCK: 'docked',
        FLOAT: 'floating',
        HIDE: 'hidden',
        SET_OFFSET: { actions: 'setOffset' },
      },
    },
    hidden: {
      on: {
        SHOW: 'floating',
        DOCK: 'docked',
        FLOAT: 'floating',
        SET_OFFSET: { actions: 'setOffset' },
      },
    },
  },
})
