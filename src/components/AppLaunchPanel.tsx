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

  const actions = {
    ariaLabel: `Launch ${name}`,
    tertiary: {
      label: 'Cancel',
      shortLabel: 'Cancel',
      onClick: clearNavChild,
      icon: <CloseIcon size={18} />,
    },
    secondary: {
      label: 'Open in-app',
      shortLabel: 'In-app',
      onClick: openInApp,
      disabled: !safeUrl || !inAppAvailable,
      icon: <AppsIcon size={18} />,
    },
    primary: {
      label: 'Open in browser',
      shortLabel: 'Browser',
      onClick: () => void openExternal(),
      disabled: !safeUrl,
      icon: <LaunchIcon size={18} />,
      tone: 'primary',
    },
  } as const

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
        Choose where to open this app. Both options use the same connected wallet
        permissions.
      </p>

      <div className="app-launch-options" aria-label="Launch options">
        <div className="app-launch-option">
          <span className="scope-icon">
            <AppsIcon size={16} />
          </span>
          <span className="app-launch-option-copy">
            <strong>Open in HandCash</strong>
            <small>
              {inAppAvailable
                ? 'Keep the app inside a HandCash-controlled browser window.'
                : 'The in-app browser is unavailable on this device.'}
            </small>
          </span>
        </div>
        <div className="app-launch-option">
          <span className="scope-icon">
            <LaunchIcon size={16} />
          </span>
          <span className="app-launch-option-copy">
            <strong>Open in browser</strong>
            <small>Launch the app in your default system browser.</small>
          </span>
        </div>
      </div>
    </WalletRequestTemplate>
  )
}
