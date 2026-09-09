import { decideAppBrowserTarget } from '../wallet/appBrowserUrl'
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
  const inAppAvailable = Boolean(window.handcash?.openAppBrowser)

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

  const openInApp = () => {
    if (!safeUrl || !inAppAvailable) return
    playWalletSound('soft')
    openEmbeddedAppBrowser(origin, safeUrl)
  }

  const cancelAction = {
    label: 'Cancel',
    shortLabel: 'Cancel',
    onClick: clearNavChild,
    icon: <CloseIcon size={18} />,
    tone: 'danger' as const,
  }

  const inAppAction = {
    label: 'Open in-app',
    shortLabel: 'In-app',
    onClick: openInApp,
    disabled: !safeUrl || !inAppAvailable,
    icon: <AppsIcon size={18} />,
    tone: 'primary' as const,
  }

  const browserAction = {
    label: 'Open in browser',
    shortLabel: 'Browser',
    onClick: () => void openExternal(),
    disabled: !safeUrl,
    icon: <LaunchIcon size={18} />,
  }

  // Prefer the in-app browser when available — that is the immediately actionable CTA.
  const actions = inAppAvailable
    ? {
        ariaLabel: `Launch ${name}`,
        tertiary: cancelAction,
        secondary: browserAction,
        primary: inAppAction,
      }
    : {
        ariaLabel: `Launch ${name}`,
        tertiary: cancelAction,
        secondary: {
          ...inAppAction,
          tone: undefined,
        },
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
        {inAppAvailable
          ? 'Open in-app keeps the session inside HandCash. Browser uses your system default. Same wallet permissions either way.'
          : 'Open in your system browser with the same connected wallet permissions. In-app browser is unavailable on this device.'}
      </p>
    </WalletRequestTemplate>
  )
}
