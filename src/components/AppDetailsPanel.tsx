import { useEffect, useState } from 'react'
import { AppAvatar } from './AppAvatar'
import { ScopeIcon } from './ScopeIcon'
import { AppLaunchMenu } from './AppLaunchMenu'
import {
  acceptsIncomingFunds,
  getItemAccess,
  setAcceptIncomingFunds,
  subscribeConnectedApps,
  type ConnectedApp,
} from '../wallet/permissions'
import { CONNECT_SCOPES, appDisplayName, appHomepage } from '../wallet/appIdentity'
import type { ItemAccess } from '../wallet/itemAccess'
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
import { AppCatalogPacksPanel } from './IndexExpansionsPanel'

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
  const [itemAccess, setItemAccess] = useState<ItemAccess>(() => getItemAccess(app.origin))
  const [acceptIncoming, setAcceptIncoming] = useState(() =>
    acceptsIncomingFunds(app.origin),
  )

  useEffect(() => {
    setItemAccess(getItemAccess(app.origin))
    setAcceptIncoming(acceptsIncomingFunds(app.origin))
  }, [app.origin, app.acceptIncomingFunds])

  useEffect(
    () =>
      subscribeConnectedApps((apps) => {
        const hit = apps.find((a) => a.origin === app.origin)
        if (hit) {
          setItemAccess(getItemAccess(hit.origin))
          setAcceptIncoming(acceptsIncomingFunds(hit.origin))
        }
      }),
    [app.origin],
  )

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
    >
      <div className="app-details-head app-details-overview-head">
        <div className="app-details-identity">
          <AppAvatar origin={app.origin} name={name} size="md" />
          <div className="app-details-head-text">
            <h3 id="app-details-title">{name}</h3>
            <span className="mono app-details-host">{app.origin}</span>
          </div>
        </div>
        <dl className="app-activity-stats" aria-label="Activity">
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

      <div className="app-details-section">
        <p className="scope-list-label">Permissions</p>
        <div className="permission-chips" aria-label="Permissions">
          {CONNECT_SCOPES.map((scope) => {
            const itemGranted =
              scope.id === 'items-view'
                ? itemAccess.view !== 'none'
                : scope.id === 'items-send'
                  ? true
                  : scope.id === 'items-receive'
                    ? itemAccess.canReceive
                    : scope.id === 'receive'
                      ? acceptIncoming
                      : true
            return (
              <button
                key={scope.id}
                type="button"
                className={
                  itemGranted
                    ? 'permission-chip'
                    : 'permission-chip permission-chip-muted'
                }
                title={
                  itemGranted
                    ? scope.description
                    : `${scope.description} (not granted yet)`
                }
                onClick={() => openPermissionDetails(app.origin, scope.id)}
              >
                <ScopeIcon scopeId={scope.id} size={13} />
                {scope.label}
              </button>
            )
          })}
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

      <AppCatalogPacksPanel origin={app.origin} />

      <div className="actions app-details-actions wallet-action-bar">
        {home ? <AppLaunchMenu url={home} origin={app.origin} name={name} /> : null}
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
        {acceptIncoming ? (
          <button
            className="btn btn-ghost"
            type="button"
            onClick={() => {
              playWalletSound('soft')
              setAcceptIncomingFunds(app.origin, false)
            }}
          >
            Require receive approval
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
    </div>
  )
}
