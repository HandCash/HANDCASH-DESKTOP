import { useEffect, useMemo, useState } from 'react'
import { AppAvatar } from './AppAvatar'
import { CollectionViewToggle } from './CollectionViewToggle'
import { SkeletonAppCard, SkeletonAppRow } from './Skeleton'
import { appDisplayName, appHomepage } from '../wallet/appIdentity'
import type { ConnectedApp } from '../wallet/permissions'
import {
  formatPrimaryFromSats,
  getCachedUsdPerBsv,
  satsToUsd,
  subscribeUsdRate,
} from '../wallet/fx'
import {
  getDisplayCurrency,
  subscribeDisplayCurrency,
  type DisplayCurrency,
} from '../wallet/displayCurrency'
import {
  getAppActivityVolume,
  getAppLastActivityAt,
  getAppMoneySummary,
  getSpentSatsSince,
  subscribeAppActivity,
} from '../wallet/appActivity'
import { getAutoPaySettings, subscribeAutoPay } from '../wallet/autoPay'
import {
  getCollectionView,
  subscribeCollectionView,
  type CollectionView,
} from '../wallet/collectionView'
import { openAppDetails } from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import { EmptyState } from './EmptyState'
import { AppsIcon, SettingsIcon } from './icons'
import { AppLaunchMenu } from './AppLaunchMenu'

type Props = {
  apps: ConnectedApp[]
}

function AppSpendLimit({
  origin,
  usdPerBsv,
}: {
  origin: string
  usdPerBsv: number | null
}) {
  const autoPay = getAutoPaySettings(origin)
  if (!autoPay?.enabled || !usdPerBsv) {
    return (
      <div
        className="connected-app-limit connected-app-limit--empty"
        aria-hidden="true"
      />
    )
  }
  const since = Date.now() - autoPay.windowHours * 60 * 60_000
  const spentUsd = satsToUsd(getSpentSatsSince(origin, since), usdPerBsv)
  const progress = spentUsd / autoPay.maxUsd
  const title = `$${spentUsd.toFixed(2)} of $${autoPay.maxUsd.toFixed(2)} AutoPay used over ${autoPay.windowHours}h`
  const percent = Math.min(100, Math.max(0, progress * 100))
  return (
    <div
      className="connected-app-limit"
      role="progressbar"
      aria-label="AutoPay limit used"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      title={title}
    >
      <span style={{ width: `${percent}%` }} />
    </div>
  )
}

function AppListItem({
  app,
  currency,
  usdPerBsv,
}: {
  app: ConnectedApp
  currency: DisplayCurrency
  usdPerBsv: number | null
}) {
  const [ready, setReady] = useState(false)
  const name = app.name || appDisplayName(app.origin)
  const money = getAppMoneySummary(app.origin)
  const home = appHomepage(app.origin)
  const spent24 = money.spent24h
  const primary = formatPrimaryFromSats(spent24, currency, usdPerBsv)

  return (
    <li className="connected-app-row" data-ready={ready ? true : undefined}>
      {!ready ? <SkeletonAppRow /> : null}
      {/* Keep in DOM (not display:none) so favicon can load under the skeleton. */}
      <div className={ready ? 'connected-app-row-live' : 'media-preload'}>
        <div className="connected-app-card-top">
          <button
            type="button"
            className="connected-app-main"
            tabIndex={ready ? 0 : -1}
            onClick={() => {
              playWalletSound('soft')
              openAppDetails(app)
            }}
          >
            <AppAvatar origin={app.origin} name={name} size="sm" onReady={() => setReady(true)} />
            <div className="connected-app-body">
              <strong className="connected-app-name">{name}</strong>
              <span className="connected-app-host mono">{app.origin}</span>
            </div>
          </button>
        </div>
        <div className="connected-app-stats">
          <div className="connected-app-usd" data-currency={currency}>
            <span className="connected-app-usd-primary">{primary}</span>
            <span className="connected-app-usd-label">spent 24h</span>
          </div>
          <AppSpendLimit origin={app.origin} usdPerBsv={usdPerBsv} />
        </div>
        <div className="connected-app-card-actions">
          <button
            type="button"
            className="btn btn-ghost btn-icon connected-app-icon-action"
            aria-label={`Manage ${name}`}
            title={`Manage ${name}`}
            onClick={() => openAppDetails(app)}
          >
            <SettingsIcon size={17} />
          </button>
          {home ? <AppLaunchMenu url={home} origin={app.origin} name={name} /> : null}
        </div>
      </div>
    </li>
  )
}

function AppGridItem({
  app,
  currency,
  usdPerBsv,
}: {
  app: ConnectedApp
  currency: DisplayCurrency
  usdPerBsv: number | null
}) {
  const [ready, setReady] = useState(false)
  const name = app.name || appDisplayName(app.origin)
  const money = getAppMoneySummary(app.origin)
  const home = appHomepage(app.origin)
  const spent24 = money.spent24h
  const primary = formatPrimaryFromSats(spent24, currency, usdPerBsv)

  return (
    <li className="collection-grid-card" data-ready={ready ? true : undefined}>
      {!ready ? <SkeletonAppCard /> : null}
      <div className={ready ? 'collection-grid-live' : 'media-preload'}>
        <div className="collection-grid-main">
          <div className="connected-app-card-top">
            <button
              type="button"
              className="connected-app-main"
              tabIndex={ready ? 0 : -1}
              onClick={() => {
                playWalletSound('soft')
                openAppDetails(app)
              }}
            >
              <AppAvatar origin={app.origin} name={name} size="md" onReady={() => setReady(true)} />
              <span className="connected-app-body">
                <strong className="collection-grid-name">{name}</strong>
                <span className="collection-grid-host mono">{app.origin}</span>
              </span>
            </button>
          </div>
          <div className="connected-app-stats">
            <span className="connected-app-usd" data-currency={currency}>
              <span className="connected-app-usd-primary">{primary}</span>
            <span className="connected-app-usd-label">spent 24h</span>
            </span>
            <AppSpendLimit origin={app.origin} usdPerBsv={usdPerBsv} />
          </div>
          <div className="connected-app-card-actions">
            <button
              type="button"
              className="btn btn-ghost btn-icon connected-app-icon-action"
              aria-label={`Manage ${name}`}
              title={`Manage ${name}`}
              onClick={() => openAppDetails(app)}
            >
              <SettingsIcon size={17} />
            </button>
            {home ? <AppLaunchMenu url={home} origin={app.origin} name={name} /> : null}
          </div>
        </div>
      </div>
    </li>
  )
}

export function ConnectedAppsPanel({ apps }: Props) {
  const [usdPerBsv, setUsdPerBsv] = useState<number | null>(() => getCachedUsdPerBsv())
  const [currency, setCurrency] = useState<DisplayCurrency>(() => getDisplayCurrency())
  const [view, setView] = useState<CollectionView>(() => getCollectionView('apps'))
  const [tick, setTick] = useState(0)

  useEffect(() => subscribeUsdRate(setUsdPerBsv), [])
  useEffect(() => subscribeDisplayCurrency(setCurrency), [])
  useEffect(() => subscribeCollectionView(setView, 'apps'), [])
  useEffect(() => subscribeAppActivity(() => setTick((n) => n + 1)), [])
  useEffect(() => subscribeAutoPay(() => setTick((n) => n + 1)), [])

  const orderedApps = useMemo(() => {
    void tick
    return apps.slice().sort((a, b) => {
      const vol = getAppActivityVolume(b.origin) - getAppActivityVolume(a.origin)
      if (vol !== 0) return vol
      const recent = getAppLastActivityAt(b.origin) - getAppLastActivityAt(a.origin)
      if (recent !== 0) return recent
      return b.connectedAt - a.connectedAt
    })
  }, [apps, tick])

  return (
    <div
      className="nav-section-body nav-section-with-scroll"
      data-aeon-scope="connected-apps"
      data-aeon-state={view}
    >
      <div className="connected-panel-head">
        <h2>Connected apps</h2>
        <CollectionViewToggle label="Connected apps view" scope="apps" />
      </div>
      {orderedApps.length === 0 ? (
        <EmptyState
          icon={<AppsIcon size={28} />}
          title="No apps connected"
          body="When a site connects through BRC-100, it shows up here with spend and permission history."
        />
      ) : (
        <div className="nav-section-scroll-body">
          {view === 'grid' ? (
            <ul className="collection-grid">
              {orderedApps.map((app) => (
                <AppGridItem
                  key={app.origin}
                  app={app}
                  currency={currency}
                  usdPerBsv={usdPerBsv}
                />
              ))}
            </ul>
          ) : (
            <ul className="connected-app-list">
              {orderedApps.map((app) => (
                <AppListItem
                  key={app.origin}
                  app={app}
                  currency={currency}
                  usdPerBsv={usdPerBsv}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
