import { decideAppBrowserTarget } from '../wallet/appBrowserUrl'
import { clearNavChild } from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import { toastError } from '../wallet/toast'
import { AppAvatar } from './AppAvatar'
import { AppsIcon, CloseIcon, LaunchIcon } from './icons'
import { useWalletActionDock } from './WalletActionDock'

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

  const openInApp = async () => {
    if (!safeUrl || !window.handcash?.openAppBrowser) return
    playWalletSound('soft')
    clearNavChild()
    try {
      const result = await window.handcash.openAppBrowser(safeUrl)
      if (!result.ok) toastError('Could not open app', result.error)
    } catch (err) {
      toastError('Could not open app', err instanceof Error ? err.message : String(err))
    }
  }

  useWalletActionDock({
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
      onClick: () => void openInApp(),
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
  })

  return (
    <div
      className="nav-child-panel permission-request-panel app-launch-panel"
      data-aeon-scope="app-launch"
    >
      <div className="permission-request-scroll">
        <div className="connect-app-hero">
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

        <div className="connect-scope-list" aria-label="Launch options">
          <div className="connect-scope-row">
            <span className="scope-icon">
              <AppsIcon size={16} />
            </span>
            <span>
              <strong>Open in HandCash</strong>
              <small>
                {inAppAvailable
                  ? 'Keep the app inside a HandCash-controlled browser window.'
                  : 'The in-app browser is unavailable on this device.'}
              </small>
            </span>
          </div>
          <div className="connect-scope-row">
            <span className="scope-icon">
              <LaunchIcon size={16} />
            </span>
            <span>
              <strong>Open in browser</strong>
              <small>Launch the app in your default system browser.</small>
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
