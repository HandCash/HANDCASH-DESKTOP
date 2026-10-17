import { assign, setup } from 'xstate'

export type AppBrowserPageHistory = { back: boolean; forward: boolean }

/** Where the page stands relative to the tab's app, for the location bar. */
export type AppBrowserLocation =
  /** On the app's own host over https. */
  | 'app'
  /** Plain http, which the guest allows only on this device's loopback. */
  | 'insecure'
  /** The page navigated or was redirected to another host. */
  | 'elsewhere'

/**
 * Chart: appBrowserPage
 * States: loading → ready | failed; ready → loading; failed → loading (RETRY)
 * Events: LOADING, PROGRESS, LOADED, NAVIGATED, FAILED (from the guest);
 *         BACK, FORWARD, RELOAD, STOP, RETRY (from the toolbar)
 *
 * One app tab's page. The guest (Electron `<webview>` or Android WebView)
 * reports what the page did; toolbar buttons send events, and the chart runs
 * the guest command (`goBack`, `goForward`, `reload`, `stop`) the component
 * provides. Nothing outside the chart tracks loading or failure.
 */
export const appBrowserPageMachine = setup({
  types: {
    context: {} as {
      /** The app the tab was opened for (origin). */
      origin: string
      url: string
      history: AppBrowserPageHistory
      failure: string | null
      /** 0–100 when the guest measures load progress; null draws an indeterminate bar. */
      progress: number | null
    },
    events: {} as
      | { type: 'LOADING' }
      | { type: 'PROGRESS'; value: number }
      | { type: 'LOADED'; history: AppBrowserPageHistory }
      | { type: 'NAVIGATED'; url: string; history: AppBrowserPageHistory }
      | { type: 'FAILED'; description: string }
      | { type: 'BACK' }
      | { type: 'FORWARD' }
      | { type: 'RELOAD' }
      | { type: 'STOP' }
      | { type: 'RETRY' },
    input: {} as { origin: string; url: string },
  },
  actions: {
    goBack: () => undefined,
    goForward: () => undefined,
    reload: () => undefined,
    stop: () => undefined,
    rememberUrl: () => undefined,
    capturePreview: () => undefined,
  },
  guards: {
    canGoBack: ({ context }) => context.history.back,
    canGoForward: ({ context }) => context.history.forward,
  },
}).createMachine({
  id: 'appBrowserPage',
  initial: 'loading',
  context: ({ input }) => ({
    origin: input.origin,
    url: input.url,
    history: { back: false, forward: false },
    failure: null,
    progress: null,
  }),
  on: {
    NAVIGATED: {
      actions: [
        assign({ url: ({ event }) => event.url, history: ({ event }) => event.history }),
        'rememberUrl',
      ],
    },
    FAILED: {
      target: '.failed',
      actions: assign({ failure: ({ event }) => event.description }),
    },
    LOADING: { target: '.loading' },
    BACK: { guard: 'canGoBack', actions: 'goBack' },
    FORWARD: { guard: 'canGoForward', actions: 'goForward' },
  },
  states: {
    loading: {
      entry: assign({ failure: null, progress: null }),
      on: {
        PROGRESS: {
          actions: assign({
            progress: ({ event }) => Math.max(0, Math.min(100, Math.round(event.value))),
          }),
        },
        LOADED: {
          target: 'ready',
          actions: [assign({ history: ({ event }) => event.history }), 'capturePreview'],
        },
        STOP: { target: 'ready', actions: 'stop' },
      },
    },
    ready: {
      on: {
        LOADED: { actions: assign({ history: ({ event }) => event.history }) },
        RELOAD: { target: 'loading', actions: 'reload' },
      },
    },
    failed: {
      on: {
        RETRY: { target: 'loading', actions: 'reload' },
        RELOAD: { target: 'loading', actions: 'reload' },
        // A failed page reports nothing else; keep the card until the user acts.
        LOADED: {},
      },
    },
  },
})

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

/**
 * The tab's app is its origin's host; a subdomain of it is still the app
 * (`play.example.com` under `example.com`). Anything else is somewhere the
 * user should know they have gone.
 */
export function appBrowserLocation(origin: string, url: string): AppBrowserLocation {
  const app = hostOf(origin.includes('://') ? origin : `https://${origin}`)
  const page = hostOf(url)
  if (!app || !page) return 'elsewhere'
  if (page !== app && !page.endsWith(`.${app}`)) return 'elsewhere'
  return url.toLowerCase().startsWith('http:') ? 'insecure' : 'app'
}

export function appBrowserPageHost(url: string): string {
  return hostOf(url) ?? url
}
