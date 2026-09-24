import { decideAppBrowserTarget } from './appBrowserUrl'
import { chooseAppBrowserSurface } from './appBrowserSurface'
import { openEmbeddedAppBrowser } from './navStore'

async function openSystemBrowser(url: string): Promise<boolean> {
  try {
    if (window.handcash?.openExternal) {
      await window.handcash.openExternal(url)
      return true
    }
  } catch {
    /* fall through */
  }
  try {
    const opened = window.open(url, '_blank', 'noopener,noreferrer')
    return Boolean(opened)
  } catch {
    return false
  }
}

/**
 * Open a connected-app URL.
 *
 * Desktop may hand off to the system browser. On mobile the system browser
 * cannot reach loopback `:3321`, so the wallet's native in-app browser is the
 * default whenever that surface exists — pass `preferInApp: false` only when
 * the user explicitly chose "Open in browser".
 */
export async function openAppInWalletBrowser(args: {
  origin: string
  url: string
  /** Force in-app (true) or system browser (false). Omit to pick by surface. */
  preferInApp?: boolean
}): Promise<'embedded' | 'native' | 'external' | 'unavailable'> {
  const target = decideAppBrowserTarget(args.url)
  if (target.kind !== 'open') return 'unavailable'

  const surface = chooseAppBrowserSurface(window.handcash)
  // Mobile's system browser cannot reach loopback `:3321`, so in-app is the
  // default there. Desktop keeps the system browser unless preferInApp is set.
  const preferInApp = args.preferInApp ?? surface.surface === 'native'

  if (preferInApp) {
    if (surface.surface === 'embedded') {
      openEmbeddedAppBrowser(args.origin, target.url)
      return 'embedded'
    }
    if (surface.surface === 'native') {
      try {
        const result = await window.handcash?.openAppBrowser?.(target.url)
        if (result?.ok) return 'native'
      } catch {
        /* fall through to the system browser */
      }
    }
  }

  if (await openSystemBrowser(target.url)) return 'external'
  return 'unavailable'
}

/** Fire-and-forget launch used after connect / Visit site / launch button. */
export function launchConnectedApp(origin: string, url?: string | null): void {
  const targetUrl = url?.trim() || null
  if (!targetUrl) return
  void openAppInWalletBrowser({ origin, url: targetUrl })
}
