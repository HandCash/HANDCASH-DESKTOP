import { isLabEnabled } from './labs'

/**
 * Which in-app surface a connected app opens on. Both shells show the same
 * browser panel (toolbar, tabs, previews); only the guest that draws the page
 * differs.
 *
 * Desktop draws it with an Electron `<webview>`. Android has no such element —
 * `createElement('webview')` yields an inert node that never loads — so the
 * mobile shell lays a native WebView over the panel's content area through
 * `appBrowserGuest`. Neither guest carries a wallet interface: the page reaches
 * the wallet over the local BRC-100 bridge, as it does from Chrome.
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

/**
 * The native guest is still being proven on phones, so it stays behind
 * Settings → Labs → In-app browser. Desktop's `<webview>` is never gated.
 */
export function inAppBrowserNeedsLab(
  caps: AppBrowserCapabilities | undefined = globalCaps(),
): boolean {
  return !caps?.embeddedAppBrowser && hostsNativeGuest(caps)
}

export function chooseAppBrowserSurface(
  caps: AppBrowserCapabilities | undefined = globalCaps(),
  nativeLabEnabled: boolean = isLabEnabled('inAppBrowser'),
): AppBrowserSurface {
  if (caps?.embeddedAppBrowser) return { surface: 'embedded', host: 'webview' }
  if (hostsNativeGuest(caps) && nativeLabEnabled) return { surface: 'embedded', host: 'native' }
  return { surface: 'external' }
}

/** Opening an in-app tab is refused only where the lab gates it and is off. */
export function inAppBrowserRefused(
  caps: AppBrowserCapabilities | undefined = globalCaps(),
): boolean {
  return inAppBrowserNeedsLab(caps) && !isLabEnabled('inAppBrowser')
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
