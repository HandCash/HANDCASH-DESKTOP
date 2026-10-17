/**
 * Which in-app surface a connected app opens on. Both shells show the same
 * browser panel (toolbar, tabs, previews); only the guest that draws the page
 * differs.
 *
 * Desktop draws it with an Electron `<webview>`. Android has no such element —
 * `createElement('webview')` yields an inert node that never loads — so the
 * mobile shell lays a native WebView over the panel's content area through
 * `appBrowserGuest`. Neither guest carries a wallet interface: Desktop's page
 * reaches the wallet over the local BRC-100 bridge as it does from Chrome, and
 * Android's carries the same requests over a WebView message channel that
 * names the frame origin.
 *
 * The capability cannot be sniffed from the DOM (Electron upgrades the element
 * only once attached), so each shell declares what it hosts.
 */
export type AppBrowserHost = 'webview' | 'native'

export type AppBrowserSurface =
  /** A tab inside the wallet's browser panel. */
  | { surface: 'embedded'; host: AppBrowserHost }
  /** No wallet-controlled surface; the system browser is the only option. */
  | { surface: 'external' }

export type AppBrowserCapabilities = {
  /** Shell hosts Electron `<webview>` tabs. Desktop preload sets this. */
  embeddedAppBrowser?: boolean
  /** Shell lays a native WebView over the panel. Mobile bridge sets this. */
  appBrowserGuest?: unknown
}

function hostsNativeGuest(caps: AppBrowserCapabilities | undefined): boolean {
  const guest = caps?.appBrowserGuest as { create?: unknown } | null | undefined
  return typeof guest === 'object' && guest !== null && typeof guest.create === 'function'
}

export function chooseAppBrowserSurface(
  caps: AppBrowserCapabilities | undefined = globalCaps(),
): AppBrowserSurface {
  if (caps?.embeddedAppBrowser) return { surface: 'embedded', host: 'webview' }
  if (hostsNativeGuest(caps)) return { surface: 'embedded', host: 'native' }
  return { surface: 'external' }
}

/**
 * Where a connected app opens unless the user picks the other surface.
 *
 * A phone keeps it in the wallet. From Chrome every request waits on a
 * wallet the OS has throttled in the background, and every prompt is an app
 * switch the OS may refuse to make; a tab has neither. Desktop answers Chrome
 * over its bridge as fast as a tab, and the system browser is where the
 * user's sessions already live.
 */
export function preferredAppSurface(
  caps: AppBrowserCapabilities | undefined = globalCaps(),
): AppBrowserSurface {
  const surface = chooseAppBrowserSurface(caps)
  return surface.surface === 'embedded' && surface.host === 'native'
    ? surface
    : { surface: 'external' }
}

function globalCaps(): AppBrowserCapabilities | undefined {
  return typeof window === 'undefined' ? undefined : window.handcash
}

/** Copy for the in-app action; only `external` would leave the wallet. */
export function appBrowserSurfaceLabel(surface: AppBrowserSurface): {
  label: string
  shortLabel: string
} {
  if (surface.surface === 'external') {
    return { label: 'Open in browser', shortLabel: 'Browser' }
  }
  return { label: 'Open in-app', shortLabel: 'In-app' }
}
