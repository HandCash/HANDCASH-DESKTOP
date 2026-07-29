import { useEffect, useState } from 'react'
import { AppAvatar } from './AppAvatar'
import { CollectionViewToggle } from './CollectionViewToggle'
import { SkeletonAppCard, SkeletonAppRow } from './Skeleton'
import { appDisplayName } from '../wallet/appIdentity'
import type { ConnectedApp } from '../wallet/permissions'
import {
  formatPrimaryFromSats,
  formatSecondaryFromSats,
  getCachedUsdPerBsv,
  subscribeUsdRate,
} from '../wallet/fx'
import {
  getDisplayCurrency,
  subscribeDisplayCurrency,
  type DisplayCurrency,
} from '../wallet/displayCurrency'
import {
  getAppMoneySummary,
  subscribeAppActivity,
} from '../wallet/appActivity'
import {
  getCollectionView,
  subscribeCollectionView,
  type CollectionView,
} from '../wallet/collectionView'
import { openAppDetails } from '../wallet/navStore'

type Props = {
  apps: ConnectedApp[]
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
  const spent24 = money.spent24h
  const primary = formatPrimaryFromSats(spent24, currency, usdPerBsv)
  const secondary = formatSecondaryFromSats(spent24, currency, usdPerBsv)

  return (
    <li className="connected-app-row" data-ready={ready ? true : undefined}>
      {!ready ? <SkeletonAppRow /> : null}
      {/* Keep in DOM (not display:none) so favicon can load under the skeleton. */}
      <div className={ready ? 'connected-app-row-live' : 'media-preload'}>
        <button
          type="button"
          className="connected-app-main"
          tabIndex={ready ? 0 : -1}
          onClick={() => openAppDetails(app)}
        >
          <AppAvatar origin={app.origin} name={name} size="sm" onReady={() => setReady(true)} />
          <div className="connected-app-body">
            <strong className="connected-app-name">{name}</strong>
            <span className="connected-app-host mono">{app.origin}</span>
          </div>
        </button>
        <button
          type="button"
          className="connected-app-usd"
          data-currency={currency}
          tabIndex={ready ? 0 : -1}
          onClick={() => openAppDetails(app)}
        >
          <span className="connected-app-usd-amounts">
            <span className="connected-app-usd-primary">{primary}</span>
            <span className="connected-app-usd-secondary">{secondary}</span>
          </span>
          <span className="connected-app-usd-label">spent 24h</span>
        </button>
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
  const spent24 = money.spent24h
  const primary = formatPrimaryFromSats(spent24, currency, usdPerBsv)
  const secondary = formatSecondaryFromSats(spent24, currency, usdPerBsv)

  return (
    <li className="collection-grid-card" data-ready={ready ? true : undefined}>
      {!ready ? <SkeletonAppCard /> : null}
      <div className={ready ? 'collection-grid-live' : 'media-preload'}>
        <button
          type="button"
          className="collection-grid-main"
          tabIndex={ready ? 0 : -1}
          onClick={() => openAppDetails(app)}
        >
          <AppAvatar origin={app.origin} name={name} size="md" onReady={() => setReady(true)} />
          <strong className="collection-grid-name">{name}</strong>
          <span className="collection-grid-host mono">{app.origin}</span>
          <span className="connected-app-usd" data-currency={currency}>
            <span className="connected-app-usd-amounts">
              <span className="connected-app-usd-primary">{primary}</span>
              <span className="connected-app-usd-secondary">{secondary}</span>
            </span>
            <span className="connected-app-usd-label">spent 24h</span>
          </span>
        </button>
      </div>
    </li>
  )
}

export function ConnectedAppsPanel({ apps }: Props) {
  const [usdPerBsv, setUsdPerBsv] = useState<number | null>(() => getCachedUsdPerBsv())
  const [currency, setCurrency] = useState<DisplayCurrency>(() => getDisplayCurrency())
  const [view, setView] = useState<CollectionView>(() => getCollectionView())
  const [tick, setTick] = useState(0)

  useEffect(() => subscribeUsdRate(setUsdPerBsv), [])
  useEffect(() => subscribeDisplayCurrency(setCurrency), [])
  useEffect(() => subscribeCollectionView(setView), [])
  useEffect(() => subscribeAppActivity(() => setTick((n) => n + 1)), [])
  void tick

  return (
    <div
      className="nav-section-body"
      data-aeon-scope="connected-apps"
      data-aeon-state={view}
    >
      <div className="connected-panel-head">
        <h2>Apps</h2>
        <CollectionViewToggle label="Apps view" />
      </div>
      {apps.length === 0 ? (
        <p className="connected-empty-line">No apps connected</p>
      ) : view === 'grid' ? (
        <ul className="collection-grid">
          {apps.map((app) => (
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
          {apps.map((app) => (
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
  )
}
