import { assign, fromPromise, setup } from 'xstate'
import { decideAppBrowserTarget } from '../wallet/appBrowserUrl'

export type AppBrowserOpener = (
  url: string,
) => Promise<{ ok: true } | { ok: false; error: string }>

/**
 * Chart: appBrowser
 * States: editing → opening → handedOff | refused → editing
 * Events: TYPE, OPEN, DISMISS
 *
 * The wallet does not render the page — a native in-app browser does — so this
 * chart owns only the hand-off: what was typed, whether it is allowed, and what
 * the shell said. A refused address never reaches the shell.
 */
export const appBrowserMachine = setup({
  types: {
    context: {} as {
      open: AppBrowserOpener
      input: string
      /** Allowed target awaiting hand-off. */
      pending: { url: string; host: string } | null
      host: string | null
      error: string | null
    },
    events: {} as
      | { type: 'TYPE'; value: string }
      | { type: 'OPEN' }
      | { type: 'DISMISS' },
    input: {} as { open: AppBrowserOpener },
  },
  actors: {
    openTarget: fromPromise(
      ({ input }: { input: { open: AppBrowserOpener; url: string } }) =>
        input.open(input.url),
    ),
  },
  guards: {
    targetAllowed: ({ context }) => decideAppBrowserTarget(context.input).kind === 'open',
  },
}).createMachine({
  id: 'appBrowser',
  initial: 'editing',
  context: ({ input }) => ({
    open: input.open,
    input: '',
    pending: null,
    host: null,
    error: null,
  }),
  states: {
    editing: {
      on: {
        TYPE: {
          actions: assign({ input: ({ event }) => event.value, error: null }),
        },
        OPEN: [
          {
            guard: 'targetAllowed',
            target: 'opening',
            actions: assign({
              pending: ({ context }) => {
                const target = decideAppBrowserTarget(context.input)
                return target.kind === 'open' ? { url: target.url, host: target.host } : null
              },
              error: null,
            }),
          },
          {
            target: 'refused',
            actions: assign({
              error: ({ context }) => {
                const target = decideAppBrowserTarget(context.input)
                return target.kind === 'refuse' ? target.message : 'Address not allowed'
              },
            }),
          },
        ],
      },
    },
    opening: {
      invoke: {
        src: 'openTarget',
        input: ({ context }) => ({
          open: context.open,
          url: context.pending?.url ?? '',
        }),
        onDone: [
          {
            guard: ({ event }) => event.output.ok,
            target: 'handedOff',
            actions: assign({
              host: ({ context }) => context.pending?.host ?? null,
              pending: null,
              error: null,
            }),
          },
          {
            target: 'refused',
            actions: assign({
              error: ({ event }) =>
                event.output.ok ? null : event.output.error || 'Could not open the browser',
              pending: null,
            }),
          },
        ],
        onError: {
          target: 'refused',
          actions: assign({
            error: ({ event }) =>
              event.error instanceof Error ? event.error.message : 'Could not open the browser',
            pending: null,
          }),
        },
      },
    },
    handedOff: {
      on: {
        TYPE: {
          target: 'editing',
          actions: assign({ input: ({ event }) => event.value, error: null }),
        },
        DISMISS: { target: 'editing' },
      },
    },
    refused: {
      on: {
        TYPE: {
          target: 'editing',
          actions: assign({ input: ({ event }) => event.value, error: null }),
        },
        DISMISS: { target: 'editing', actions: assign({ error: null }) },
      },
    },
  },
})
