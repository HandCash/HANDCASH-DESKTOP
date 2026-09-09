import { decideAppBrowserTarget } from '../wallet/appBrowserUrl'
import { launchConnectedApp } from '../wallet/openAppInWalletBrowser'
import { playWalletSound } from '../wallet/soundService'
import { LaunchIcon } from './icons'

type Props = {
  url: string
  origin: string
  name: string
  compact?: boolean
}

export function AppLaunchMenu({ url, origin, name }: Props) {
  const target = decideAppBrowserTarget(url)
  if (target.kind !== 'open') return null

  return (
    <button
      type="button"
      className="btn btn-primary btn-icon connected-app-icon-action"
      aria-label={`Open ${name} in-app`}
      title={`Open ${name} in-app`}
      onClick={() => {
        playWalletSound('soft')
        launchConnectedApp(origin, target.url)
      }}
    >
      <LaunchIcon size={17} />
    </button>
  )
}
