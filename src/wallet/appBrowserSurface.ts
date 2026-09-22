/**
 * Where "Open in-app" actually puts a connected app.
 *
 * The embedded tab is an Electron `<webview>`. Android has no such element —
 * `createElement('webview')` yields an inert unknown element that never loads
 * and never errors, so the panel sits on its spinner forever. The capability
 * cannot be sniffed from the DOM either: Electron only upgrades the element
 * once it is attached, so a detached probe reports no methods even when the
 * tag is enabled. The shell therefore declares it.
 *
 * `openAppBrowser` is not that declaration. Both shells expose it, but on
 * mobile it hands the URL to the system browser — treating it as proof of an
 * embedded surface is what offered a dead in-app tab on the phone.
 */
export type AppBrowserSurface =
  /** Electron `<webview>` tab inside the wallet window. */
  | { surface: 'embedded' }
  /** Shell opens its own browser (mobile system browser) and we step aside. */
  | { surface: 'native' }
  /** No wallet-controlled surface; the system browser is the only option. */
  | { surface: 'external' }

export type AppBrowserCapabilities = {
  /** Shell hosts Electron `<webview>` tabs. Desktop preload sets this. */
  embeddedAppBrowser?: boolean
  openAppBrowser?: unknown
}

export function chooseAppBrowserSurface(
  caps: AppBrowserCapabilities | undefined,
): AppBrowserSurface {
  if (caps?.embeddedAppBrowser) return { surface: 'embedded' }
  if (typeof caps?.openAppBrowser === 'function') return { surface: 'native' }
  return { surface: 'external' }
}

/** Copy for the in-app action, so the button never promises the wrong surface. */
export function appBrowserSurfaceLabel(surface: AppBrowserSurface): {
  label: string
  shortLabel: string
} {
  if (surface.surface === 'embedded') {
    return { label: 'Open in-app', shortLabel: 'In-app' }
  }
  return { label: 'Open in app browser', shortLabel: 'App browser' }
}
