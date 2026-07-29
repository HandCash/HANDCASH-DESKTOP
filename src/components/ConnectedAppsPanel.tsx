import { useEffect, useState } from 'react'
import { AppAvatar } from './AppAvatar'
import { AppDetailsDialog } from './AppDetailsDialog'
import { LaunchIcon } from './icons'
import { appDisplayName, appHomepage } from '../wallet/appIdentity'
import type { ConnectedApp } from '../wallet/permissions'
import {
  formatUsdFromSats,
  getCachedUsdPerBsv,
  subscribeUsdRate,
} from '../wallet/fx'
import {
  getAppMoneySummary,
  subscribeAppActivity,
} from '../wallet/appActivity'

type Props = {
  apps: ConnectedApp[]
  onRevoke: (origin: string) => void
}

async function launchApp(origin: string) {
  const url = appHomepage(origin)
  if (!url) return
  if (window.handcash?.openExternal) {
    await window.handcash.openExternal(url)
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

export function ConnectedAppsPanel({ apps, onRevoke }: Props) {
  const [selected, setSelected] = useState<ConnectedApp | null>(null)
  const [usdPerBsv, setUsdPerBsv] = useState<number | null>(() => getCachedUsdPerBsv())
  const [tick, setTick] = useState(0)

  useEffect(() => subscribeUsdRate(setUsdPerBsv), [])
  useEffect(() => subscribeAppActivity(() => setTick((n) => n + 1)), [])

  return (
    <div className="nav-section-body" data-aeon-scope="connected-apps">
      <div className="connected-panel-head">
        <h2>Apps</h2>
      </div>
      {apps.length === 0 ? (
        <p className="connected-empty-line">No apps connected</p>
      ) : (
        <ul className="connected-app-list">
          {apps.map((app) => {
            const name = app.name || appDisplayName(app.origin)
            const money = getAppMoneySummary(app.origin)
            void tick
            const spent24 = money.spent24h
            const home = appHomepage(app.origin)
            return (
              <li key={app.origin} className="connected-app-row">
                <button
                  type="button"
                  className="connected-app-main"
                  onClick={() => setSelected(app)}
                >
                  <AppAvatar origin={app.origin} name={name} size="sm" />
                  <div className="connected-app-body">
                    <strong className="connected-app-name">{name}</strong>
                    <span className="connected-app-host mono">{app.origin}</span>
                  </div>
                  <span className="connected-app-usd">
                    {formatUsdFromSats(spent24, usdPerBsv)}
                    <small>spent 24h</small>
                  </span>
                </button>
                {home ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-compact btn-icon connected-app-launch"
                    aria-label={`Launch ${name}`}
                    title={`Open ${home}`}
                    onClick={() => void launchApp(app.origin)}
                  >
                    <LaunchIcon size={14} />
                    Launch
                  </button>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}

      <AppDetailsDialog
        app={selected}
        onClose={() => setSelected(null)}
        onRevoke={onRevoke}
      />
    </div>
  )
}
