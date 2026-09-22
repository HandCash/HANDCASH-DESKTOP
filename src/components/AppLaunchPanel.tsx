import { decideAppBrowserTarget } from '../wallet/appBrowserUrl'
import {
  appBrowserSurfaceLabel,
  chooseAppBrowserSurface,
} from '../wallet/appBrowserSurface'
import { clearNavChild, openEmbeddedAppBrowser } from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import { toastError } from '../wallet/toast'
import { AppAvatar } from './AppAvatar'
import { AppsIcon, CloseIcon, LaunchIcon } from './icons'
import { WalletRequestTemplate } from './WalletRequestTemplate'

type Props = {
  origin: string
  name: string
  url: string
}

export function AppLaunchPanel({ origin, name, url }: Props) {
  const target = decideAppBrowserTarget(url)
  const safeUrl = target.kind === 'open' ? target.url : null
  const surface = chooseAppBrowserSurface(window.handcash)
  const inAppAvailable = surface.surface !== 'external'

  const openExternal = async () => {
    if (!safeUrl) return
    playWalletSound('soft')
    clearNavChild()
    try {
      if (window.handcash?.openExternal) {
        await window.handcash.openExternal(safeUrl)
      } else {
        window.open(safeUrl, '_blank', 'noopener,noreferrer')
      }
    } catch (err) {
      toastError('Could not open app', err instanceof Error ? err.message : String(err))
    }
  }

  const openInApp = async () => {
    if (!safeUrl) return
    playWalletSound('soft')
    if (surface.surface === 'embedded') {
      openEmbeddedAppBrowser(origin, safeUrl)
      return
    }
    // Mobile: the shell owns the browser. Stepping aside beats mounting a
    // `<webview>` tab that Android can never load.
    if (surface.surface === 'native') {
      clearNavChild()
      try {
        const result = await window.handcash?.openAppBrowser?.(safeUrl)
        if (result && result.ok === false) {
          toastError('Could not open app', result.error)
        }
      } catch (err) {
        toastError('Could not open app', err instanceof Error ? err.message : String(err))
      }
    }
  }

  const cancelAction = {
    label: 'Cancel',
    shortLabel: 'Cancel',
    onClick: clearNavChild,
    icon: <CloseIcon size={18} />,
    tone: 'danger' as const,
  }

  const inAppAction = {
    ...appBrowserSurfaceLabel(surface),
    onClick: () => void openInApp(),
    disabled: !safeUrl || !inAppAvailable,
    icon: <AppsIcon size={18} />,
    tone: 'secondary' as const,
  }

  const browserAction = {
    label: 'Open in browser',
    shortLabel: 'Browser',
    onClick: () => void openExternal(),
    disabled: !safeUrl,
    icon: <LaunchIcon size={18} />,
  }

  // System browser is the default return path after connect. In-app only when
  // the user explicitly picks it here.
  const actions = {
    ariaLabel: `Launch ${name}`,
    tertiary: cancelAction,
    secondary: inAppAction,
    primary: {
      ...browserAction,
      tone: 'primary' as const,
    },
  }

  return (
    <WalletRequestTemplate
      scope="app-launch"
      className="nav-child-panel app-launch-panel"
      actions={actions}
    >
      <div className="connect-app-hero app-launch-hero">
        <AppAvatar origin={origin} name={name} size="md" />
        <div>
          <p className="permission-eyebrow">Launch connected app</p>
          <h2 className="permission-request-title">{name}</h2>
          <p className="mono permission-origin">{origin}</p>
        </div>
      </div>

      <p className="permission-note">
        {surface.surface === 'embedded'
          ? 'Opens in your system browser by default. Use in-app only when you want the session inside HandCash. Same wallet permissions either way.'
          : surface.surface === 'native'
            ? 'Opens in your system browser either way — this device cannot keep an app tab inside HandCash. Same wallet permissions.'
            : 'Open in your system browser with the same connected wallet permissions. In-app browser is unavailable on this device.'}
      </p>
    </WalletRequestTemplate>
  )
}
