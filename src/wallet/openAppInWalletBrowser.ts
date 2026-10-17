import { decideAppBrowserTarget } from './appBrowserUrl'
import { chooseAppBrowserSurface, preferredAppSurface } from './appBrowserSurface'
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
 * Open a connected-app URL on the shell's preferred surface
 * (`preferredAppSurface`): a tab on a phone, the system browser on Desktop.
 * `surface` is the user's explicit pick of the other one.
 */
export async function openAppInWalletBrowser(args: {
  origin: string
  url: string
  surface?: 'in-app' | 'browser'
}): Promise<'embedded' | 'external' | 'unavailable'> {
  const target = decideAppBrowserTarget(args.url)
  if (target.kind !== 'open') return 'unavailable'

  const inApp =
    args.surface === 'in-app'
      ? chooseAppBrowserSurface(window.handcash).surface === 'embedded'
      : args.surface !== 'browser' && preferredAppSurface(window.handcash).surface === 'embedded'
  if (inApp) {
    openEmbeddedAppBrowser(args.origin, target.url)
    return 'embedded'
  }

  if (await openSystemBrowser(target.url)) return 'external'
  return 'unavailable'
}

/** Fire-and-forget launch used after connect / Visit site / launch button. */
export function launchConnectedApp(
  origin: string,
  url?: string | null,
  surface?: 'in-app' | 'browser',
): void {
  const targetUrl = url?.trim() || null
  if (!targetUrl) return
  void openAppInWalletBrowser({ origin, url: targetUrl, surface })
}
