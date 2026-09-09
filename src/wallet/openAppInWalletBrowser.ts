import { decideAppBrowserTarget } from './appBrowserUrl'
import { openEmbeddedAppBrowser } from './navStore'

/**
 * Prefer the embedded in-app browser for connected-app URLs.
 * Falls back to the native BrowserWindow helper, then the system browser.
 */
export async function openAppInWalletBrowser(args: {
  origin: string
  url: string
}): Promise<'embedded' | 'window' | 'external' | 'unavailable'> {
  const target = decideAppBrowserTarget(args.url)
  if (target.kind !== 'open') return 'unavailable'

  openEmbeddedAppBrowser(args.origin, target.url)
  return 'embedded'
}

/** Fire-and-forget launch used after connect / Visit site. */
export function launchConnectedApp(origin: string, url?: string | null): void {
  const targetUrl = url?.trim() || null
  if (!targetUrl) return
  void openAppInWalletBrowser({ origin, url: targetUrl })
}
