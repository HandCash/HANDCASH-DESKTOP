import { useEffect, useState } from 'react'
import { stateToAttr } from '@aeon-ui/core'
import { AppAvatar } from './AppAvatar'
import { ModalPortal } from './ModalPortal'
import { ScopeIcon } from './ScopeIcon'
import { LaunchIcon } from './icons'
import type { ConnectedApp } from '../wallet/permissions'
import { CONNECT_SCOPES, appDisplayName, appHomepage } from '../wallet/appIdentity'
import {
  getAppMoneySummary,
  subscribeAppActivity,
  type AppMoneySummary,
} from '../wallet/appActivity'
import {
  formatUsdFromSats,
  getCachedUsdPerBsv,
  subscribeUsdRate,
} from '../wallet/fx'
import {
  clearAutoPaySettings,
  getAutoPaySettings,
  subscribeAutoPay,
  type AutoPaySettings,
} from '../wallet/autoPay'
import { AppCatalogPacksPanel } from './IndexExpansionsPanel'

type Props = {
  app: ConnectedApp | null
  onClose: () => void
  onRevoke: (origin: string) => void
}

export function AppDetailsDialog({ app, onClose, onRevoke }: Props) {
  const [usdPerBsv, setUsdPerBsv] = useState<number | null>(() => getCachedUsdPerBsv())
  const [money, setMoney] = useState<AppMoneySummary>(() =>
    app ? getAppMoneySummary(app.origin) : { spent24h: 0, earned24h: 0, spentAll: 0, earnedAll: 0 },
  )
  const [autoPay, setAutoPay] = useState<AutoPaySettings | null>(() =>
    app ? getAutoPaySettings(app.origin) : null,
  )

  useEffect(() => subscribeUsdRate(setUsdPerBsv), [])

  useEffect(() => {
    if (!app) return
    const refresh = () => setMoney(getAppMoneySummary(app.origin))
    refresh()
    return subscribeAppActivity(refresh)
  }, [app])

  useEffect(() => {
    if (!app) return
    const refresh = () => setAutoPay(getAutoPaySettings(app.origin))
    refresh()
    return subscribeAutoPay(refresh)
  }, [app])

  if (!app) return null

  const name = app.name || appDisplayName(app.origin)
  const home = appHomepage(app.origin)

  return (
    <ModalPortal>
      <div
        className="modal-backdrop"
        data-aeon-scope="dialog"
        data-aeon-state={stateToAttr('open')}
        onClick={onClose}
        role="presentation"
      >
        <div
          className="panel modal app-details-modal"
          data-aeon-part="content"
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-labelledby="app-details-title"
        >
          <div className="app-details-head">
            <AppAvatar origin={app.origin} name={name} size="md" />
            <div className="app-details-head-text">
              <h2 id="app-details-title">{name}</h2>
              {home ? (
                <a className="mono app-details-host" href={home} target="_blank" rel="noreferrer">
                  {app.origin}
                </a>
              ) : (
                <span className="mono app-details-host">{app.origin}</span>
              )}
            </div>
          </div>

          <div className="app-details-section">
            <p className="scope-list-label">Permissions</p>
            <div className="permission-chips" aria-label="Permissions">
              {CONNECT_SCOPES.map((scope) => (
                <span key={scope.id} className="permission-chip" title={scope.description}>
                  <ScopeIcon scopeId={scope.id} size={13} />
                  {scope.label}
                </span>
              ))}
              {autoPay?.enabled ? (
                <span
                  className="permission-chip permission-chip-accent"
                  title={`Up to $${autoPay.maxUsd} every ${autoPay.windowHours} hours`}
                >
                  <ScopeIcon scopeId="auto-pay" size={13} />
                  Auto-pay · ${autoPay.maxUsd}/{autoPay.windowHours}h
                </span>
              ) : null}
            </div>
          </div>

          <div className="app-details-section app-details-activity" aria-label="Activity">
            <dl className="app-activity-stats">
              <div>
                <dt>Spent 24h</dt>
                <dd>{formatUsdFromSats(money.spent24h, usdPerBsv)}</dd>
              </div>
              <div>
                <dt>Earned 24h</dt>
                <dd>{formatUsdFromSats(money.earned24h, usdPerBsv)}</dd>
              </div>
            </dl>
          </div>

          <AppCatalogPacksPanel origin={app.origin} />

          <div className="actions qr-actions app-details-actions">
            {home ? (
              <button
                className="btn btn-primary btn-icon"
                type="button"
                onClick={() => {
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
                onClick={() => clearAutoPaySettings(app.origin)}
              >
                Turn off auto-pay
              </button>
            ) : null}
            <button
              className="btn btn-ghost"
              type="button"
              onClick={() => {
                onRevoke(app.origin)
                onClose()
              }}
            >
              Disconnect
            </button>
            <button className="btn btn-ghost" type="button" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </div>
    </ModalPortal>
  )
}
