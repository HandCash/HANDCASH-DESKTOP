import { assign, setup } from 'xstate'

export type ChartAppsContext = {
  appId: string | null
  /** Whether the open app passed verification; RUN is refused otherwise. */
  verified: boolean
  /** Opened from a launcher tile: Back closes instead of returning to the list. */
  pinned: boolean
}

type Input = { appId?: string; verified?: boolean } | undefined

/**
 * Chart: chartApps (Settings → Apps, or one app from the Apps launcher)
 * States: list → reviewing (what the app can do, before it runs) → running → list.
 * Pinned to one app: reviewing → running, and Back reaches closed.
 * An app that fails verification can be reviewed but never run.
 */
export const chartAppsMachine = setup({
  types: {
    context: {} as ChartAppsContext,
    input: {} as Input,
    events: {} as
      | { type: 'OPEN'; appId: string; verified: boolean }
      | { type: 'RUN' }
      | { type: 'BACK' },
  },
  guards: {
    verified: ({ context }) => context.verified,
    pinned: ({ context }) => context.pinned,
  },
}).createMachine({
  id: 'chartApps',
  initial: 'start',
  context: ({ input }) => ({
    appId: input?.appId ?? null,
    verified: input?.verified ?? false,
    pinned: Boolean(input?.appId),
  }),
  states: {
    start: {
      always: [{ guard: 'pinned', target: 'reviewing' }, { target: 'list' }],
    },
    list: {
      entry: assign({ appId: null, verified: false }),
      on: {
        OPEN: {
          target: 'reviewing',
          actions: assign({
            appId: ({ event }) => event.appId,
            verified: ({ event }) => event.verified,
          }),
        },
      },
    },
    reviewing: {
      on: {
        RUN: { guard: 'verified', target: 'running' },
        BACK: [{ guard: 'pinned', target: 'closed' }, { target: 'list' }],
      },
    },
    running: {
      on: { BACK: [{ guard: 'pinned', target: 'closed' }, { target: 'list' }] },
    },
    closed: { type: 'final' },
  },
})
