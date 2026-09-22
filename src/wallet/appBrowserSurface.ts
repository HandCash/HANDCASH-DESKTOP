/**
 * Which in-app surface a connected app opens on. Both shells have one, but
 * they are different mechanisms and picking the wrong one shows an empty panel.
 *
 * Desktop hosts the app as an Electron `<webview>` tab inside the wallet
 * window. Android has no such element — `createElement('webview')` yields an
 * inert unknown element that never loads and never errors, so the panel sits
 * on its spinner forever. Mobile has its own native in-app browser
 * (`DappBrowserActivity`, which carries the CWI bridge), reached through
 * `openAppBrowser`.
 *
 * The embedded capability cannot be sniffed from the DOM: Electron upgrades
 * the element only once it is attached, so a detached probe reports no methods
 * even when the tag is enabled. The shell therefore declares it, and
 * `openAppBrowser` is never read as proof of a `<webview>` host.
 */
export type AppBrowserSurface =
  /** Electron `<webview>` tab inside the wallet window. */
  | { surface: 'embedded' }
  /** Shell drives its own in-app browser (Android `DappBrowserActivity`). */
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

/**
 * Copy for the in-app action. `embedded` and `native` are both genuinely
 * in-app, so both say so; only `external` would leave the wallet.
 */
export function appBrowserSurfaceLabel(surface: AppBrowserSurface): {
  label: string
  shortLabel: string
} {
  if (surface.surface === 'external') {
    return { label: 'Open in browser', shortLabel: 'Browser' }
  }
  return { label: 'Open in-app', shortLabel: 'In-app' }
}
