import { assign, setup } from 'xstate'

export type ChartAppsContext = {
  appId: string | null
  /** Whether the open app passed verification; RUN is refused otherwise. */
  verified: boolean
}

/**
 * Chart: chartApps (Settings → Apps)
 * States: list → reviewing (what the app can do, before it runs) → running → list.
 * An app that fails verification can be reviewed but never run.
 */
export const chartAppsMachine = setup({
  types: {
    context: {} as ChartAppsContext,
    events: {} as
      | { type: 'OPEN'; appId: string; verified: boolean }
      | { type: 'RUN' }
      | { type: 'BACK' },
  },
  guards: {
    verified: ({ context }) => context.verified,
  },
}).createMachine({
  id: 'chartApps',
  initial: 'list',
  context: { appId: null, verified: false },
  states: {
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
        BACK: 'list',
      },
    },
    running: {
      on: { BACK: 'list' },
    },
  },
})
