import { decideAppBrowserTarget } from './appBrowserUrl'
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
 * Default is the **system browser** so connect / launch returns the user to
 * Chrome (or their default). Pass `preferInApp: true` only when the user
 * explicitly chose the in-app browser.
 */
export async function openAppInWalletBrowser(args: {
  origin: string
  url: string
  /** Only when the user explicitly asked for the in-app browser. */
  preferInApp?: boolean
}): Promise<'embedded' | 'window' | 'external' | 'unavailable'> {
  const target = decideAppBrowserTarget(args.url)
  if (target.kind !== 'open') return 'unavailable'

  if (args.preferInApp) {
    openEmbeddedAppBrowser(args.origin, target.url)
    return 'embedded'
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
