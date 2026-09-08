import { useRef } from 'react'
import { decideAppBrowserTarget } from '../wallet/appBrowserUrl'
import { playWalletSound } from '../wallet/soundService'
import { LaunchIcon } from './icons'

type Props = {
  url: string
  compact?: boolean
}

export function AppLaunchMenu({ url, compact = false }: Props) {
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const target = decideAppBrowserTarget(url)
  if (target.kind !== 'open') return null

  const close = () => detailsRef.current?.removeAttribute('open')
  const openExternal = () => {
    playWalletSound('soft')
    close()
    if (window.handcash?.openExternal) {
      void window.handcash.openExternal(target.url)
    } else {
      window.open(target.url, '_blank', 'noopener,noreferrer')
    }
  }
  const openInApp = () => {
    playWalletSound('soft')
    close()
    void window.handcash?.openAppBrowser?.(target.url)
  }

  return (
    <details
      ref={detailsRef}
      className={compact ? 'app-launch-menu app-launch-menu--compact' : 'app-launch-menu'}
    >
      <summary className="btn btn-primary btn-icon">
        <LaunchIcon size={15} />
        Launch
      </summary>
      <div className="app-launch-options">
        {window.handcash?.openAppBrowser ? (
          <button type="button" onClick={openInApp}>
            Open in HandCash
          </button>
        ) : null}
        <button type="button" onClick={openExternal}>
          Open in external browser
        </button>
      </div>
    </details>
  )
}
