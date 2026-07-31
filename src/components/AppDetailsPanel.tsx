import { useEffect, useState } from 'react'
import { AppAvatar } from './AppAvatar'
import { ScopeIcon } from './ScopeIcon'
import { LaunchIcon } from './icons'
import { SkeletonLine } from './Skeleton'
import type { ConnectedApp } from '../wallet/permissions'
import { CONNECT_SCOPES, appDisplayName, appHomepage } from '../wallet/appIdentity'
import {
  getAppMoneySummary,
  subscribeAppActivity,
  type AppMoneySummary,
} from '../wallet/appActivity'
import {
  formatPrimaryFromSats,
  getCachedUsdPerBsv,
  subscribeUsdRate,
} from '../wallet/fx'
import {
  getDisplayCurrency,
  subscribeDisplayCurrency,
  type DisplayCurrency,
} from '../wallet/displayCurrency'
import {
  clearAutoPaySettings,
  getAutoPaySettings,
  subscribeAutoPay,
  type AutoPaySettings,
} from '../wallet/autoPay'
import { openPermissionDetails } from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'

type Props = {
  app: ConnectedApp
  onRevoke: (origin: string) => void
  onDone: () => void
}

export function AppDetailsPanel({ app, onRevoke, onDone }: Props) {
  const [usdPerBsv, setUsdPerBsv] = useState<number | null>(() => getCachedUsdPerBsv())
  const [currency, setCurrency] = useState<DisplayCurrency>(() => getDisplayCurrency())
  const [money, setMoney] = useState<AppMoneySummary>(() => getAppMoneySummary(app.origin))
  const [autoPay, setAutoPay] = useState<AutoPaySettings | null>(() =>
    getAutoPaySettings(app.origin),
  )
  const [iconReady, setIconReady] = useState(false)

  useEffect(() => {
    setIconReady(false)
  }, [app.origin])

  useEffect(() => subscribeUsdRate(setUsdPerBsv), [])
  useEffect(() => subscribeDisplayCurrency(setCurrency), [])

  useEffect(() => {
    const refresh = () => setMoney(getAppMoneySummary(app.origin))
    refresh()
    return subscribeAppActivity(refresh)
  }, [app.origin])

  useEffect(() => {
    const refresh = () => setAutoPay(getAutoPaySettings(app.origin))
    refresh()
    return subscribeAutoPay(refresh)
  }, [app.origin])

  const name = app.name || appDisplayName(app.origin)
  const home = appHomepage(app.origin)

  return (
    <div
      className="nav-child-panel app-details-inline"
      data-aeon-scope="app-details"
      data-aeon-state={iconReady ? undefined : 'loading'}
    >
      <div className="app-details-head">
        <AppAvatar origin={app.origin} name={name} size="md" onReady={() => setIconReady(true)} />
        {iconReady ? (
          <div className="app-details-head-text">
            <h3 id="app-details-title">{name}</h3>
            <span className="mono app-details-host">{app.origin}</span>
          </div>
        ) : (
          <div className="app-details-head-text">
            <SkeletonLine width="40%" height={16} />
            <SkeletonLine width="70%" height={10} />
          </div>
        )}
      </div>

      {!iconReady ? (
        <div className="app-details-section">
          <SkeletonLine width="30%" height={10} />
          <div className="permission-chips" style={{ marginTop: 10 }}>
            <SkeletonLine width={88} height={28} />
            <SkeletonLine width={72} height={28} />
            <SkeletonLine width={96} height={28} />
          </div>
        </div>
      ) : (
        <>
          <div className="app-details-section">
            <p className="scope-list-label">Permissions</p>
            <div className="permission-chips" aria-label="Permissions">
              {CONNECT_SCOPES.map((scope) => (
                <button
                  key={scope.id}
                  type="button"
                  className="permission-chip"
                  title={scope.description}
                  onClick={() => openPermissionDetails(app.origin, scope.id)}
                >
                  <ScopeIcon scopeId={scope.id} size={13} />
                  {scope.label}
                </button>
              ))}
              {autoPay?.enabled ? (
                <button
                  type="button"
                  className="permission-chip permission-chip-accent"
                  title={`Up to $${autoPay.maxUsd} every ${autoPay.windowHours} hours`}
                  onClick={() => openPermissionDetails(app.origin, 'auto-pay')}
                >
                  <ScopeIcon scopeId="auto-pay" size={13} />
                  Auto-pay · ${autoPay.maxUsd}/{autoPay.windowHours}h
                </button>
              ) : null}
            </div>
          </div>

          <div className="app-details-section app-details-activity" aria-label="Activity">
            <dl className="app-activity-stats">
              <div>
                <dt>Spent 24h</dt>
                <dd>{formatPrimaryFromSats(money.spent24h, currency, usdPerBsv)}</dd>
              </div>
              <div>
                <dt>Earned 24h</dt>
                <dd>{formatPrimaryFromSats(money.earned24h, currency, usdPerBsv)}</dd>
              </div>
            </dl>
          </div>

          <div className="actions app-details-actions">
            {home ? (
              <button
                className="btn btn-primary btn-icon"
                type="button"
                onClick={() => {
                  playWalletSound('soft')
                  if (window.handcash?.openExternal) {
                    void window.handcash.openExternal(home)
                  } else {
                    window.open(home, '_blank', 'noopener,noreferrer')
                  }
                }}
              >
                <LaunchIcon size={16} />
                Launch
              </button>
            ) : null}
            {autoPay?.enabled ? (
              <button
                className="btn btn-ghost"
                type="button"
                onClick={() => {
                  playWalletSound('soft')
                  clearAutoPaySettings(app.origin)
                }}
              >
                Turn off auto-pay
              </button>
            ) : null}
            <button
              className="btn btn-ghost"
              type="button"
              onClick={() => {
                playWalletSound('deny')
                onRevoke(app.origin)
                onDone()
              }}
            >
              Disconnect
            </button>
          </div>
        </>
      )}
    </div>
  )
}
