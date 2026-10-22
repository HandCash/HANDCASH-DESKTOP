import { Button } from '@aeon-ui/react'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { AppAvatar } from './AppAvatar'
import { CollectionViewToggle } from './CollectionViewToggle'
import { SkeletonAppCard, SkeletonAppRow } from './Skeleton'
import { appDisplayName, appHomepage, grantedPermissionScopes } from '../wallet/appIdentity'
import {
  acceptsIncomingFunds,
  getItemAccess,
  getTokenAccess,
  type ConnectedApp,
} from '../wallet/permissions'
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
import { isCompactLayout, subscribeCompactLayout } from '../wallet/layoutViewport'
import { appAccessText, appSeenText, filterConnectedApps } from '../wallet/listPanelText'
import { openAppDetails, openDevKeys } from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import { EmptyState } from './EmptyState'
import { AppsIcon, CodeIcon, SearchIcon, SettingsIcon, ViewGridIcon } from './icons'
import { AppLaunchMenu } from './AppLaunchMenu'
import { AppsSearchBar, appsSearchAddress, canOpenAppAddresses } from './AppsSearchBar'
import { ListPanelHead } from './ListPanelHead'

type Props = {
  apps: ConnectedApp[]
  openTabCount: number
  onShowTabs: () => void
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

type AppCardProps = {
  app: ConnectedApp
  currency: DisplayCurrency
  usdPerBsv: number | null
  now: number
}

function appAccess(origin: string): string {
  return appAccessText(
    grantedPermissionScopes({
      acceptIncomingFunds: acceptsIncomingFunds(origin),
      itemAccess: getItemAccess(origin),
      tokenAccess: getTokenAccess(origin),
      autoPayEnabled: getAutoPaySettings(origin)?.enabled === true,
    }),
  )
}

function AppCardMain({
  app,
  name,
  ready,
  size,
  now,
  onReady,
}: {
  app: ConnectedApp
  name: string
  ready: boolean
  size: 'sm' | 'md'
  now: number
  onReady: () => void
}) {
  return (
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
        <AppAvatar origin={app.origin} name={name} size={size} onReady={onReady} />
        <span className="connected-app-body">
          <strong className={size === 'sm' ? 'connected-app-name' : 'collection-grid-name'}>
            {name}
          </strong>
          <span className={`${size === 'sm' ? 'connected-app-host' : 'collection-grid-host'} mono`}>
            {app.origin}
          </span>
          <span className="connected-app-access" data-aeon-part="access">
            {appAccess(app.origin)}
          </span>
          <span className="connected-app-seen" data-aeon-part="seen">
            {appSeenText(app.connectedAt, getAppLastActivityAt(app.origin), now)}
          </span>
        </span>
      </button>
    </div>
  )
}

function AppCardStats({ app, currency, usdPerBsv }: AppCardProps) {
  const primary = formatPrimaryFromSats(getAppMoneySummary(app.origin).spent24h, currency, usdPerBsv)
  return (
    <div className="connected-app-stats">
      <span className="connected-app-usd" data-currency={currency}>
        <span className="connected-app-usd-primary">{primary}</span>
        <span className="connected-app-usd-label">spent 24h</span>
      </span>
      <AppSpendLimit origin={app.origin} usdPerBsv={usdPerBsv} />
    </div>
  )
}

function AppCardActions({ app, name }: { app: ConnectedApp; name: string }) {
  const home = appHomepage(app.origin)
  return (
    <div className="connected-app-card-actions">
      <Button.Root
        variant="ghost"
        className="btn btn-ghost connected-app-manage"
        aria-label={`Manage or disconnect ${name}`}
        title={`Manage or disconnect ${name}`}
        onClick={() => {
          playWalletSound('soft')
          openAppDetails(app)
        }}
      >
        <SettingsIcon size={16} />
        <span className="connected-app-manage-label">Manage</span>
      </Button.Root>
      {home ? <AppLaunchMenu url={home} origin={app.origin} name={name} /> : null}
    </div>
  )
}

function AppListItem(props: AppCardProps) {
  const [ready, setReady] = useState(false)
  const name = props.app.name || appDisplayName(props.app.origin)
  return (
    <li className="connected-app-row" data-ready={ready ? true : undefined}>
      {!ready ? <SkeletonAppRow /> : null}
      {/* Keep in DOM (not display:none) so favicon can load under the skeleton. */}
      <div className={ready ? 'connected-app-row-live' : 'media-preload'}>
        <AppCardMain
          app={props.app}
          name={name}
          ready={ready}
          size="sm"
          now={props.now}
          onReady={() => setReady(true)}
        />
        <AppCardStats {...props} />
        <AppCardActions app={props.app} name={name} />
      </div>
    </li>
  )
}

function AppGridItem(props: AppCardProps) {
  const [ready, setReady] = useState(false)
  const name = props.app.name || appDisplayName(props.app.origin)
  return (
    <li className="collection-grid-card" data-ready={ready ? true : undefined}>
      {!ready ? <SkeletonAppCard /> : null}
      <div className={ready ? 'collection-grid-live' : 'media-preload'}>
        <div className="collection-grid-main">
          <AppCardMain
            app={props.app}
            name={name}
            ready={ready}
            size="md"
            now={props.now}
            onReady={() => setReady(true)}
          />
          <AppCardStats {...props} />
          <AppCardActions app={props.app} name={name} />
        </div>
      </div>
    </li>
  )
}

type ResultsProps = {
  apps: ConnectedApp[]
  query: string
  view: CollectionView
  currency: DisplayCurrency
  usdPerBsv: number | null
  now: number
  /** True when the typed text is a web address the search bar offers to open. */
  opensAddress: boolean
  canOpen: boolean
}

/** What sits under the search: the empty state, no matches, or the app list or grid. */
export function ConnectedAppsResults({
  apps,
  query,
  view,
  currency,
  usdPerBsv,
  now,
  opensAddress,
  canOpen,
}: ResultsProps) {
  if (apps.length === 0) {
    return (
      <EmptyState
        icon={<AppsIcon size={28} />}
        title="No apps connected"
        body={
          canOpen
            ? 'Type a web address above to open an app. Apps you connect show up here with what they can reach.'
            : 'Apps you connect show up here with what they can reach.'
        }
      />
    )
  }
  const shown = filterConnectedApps(apps, query)
  if (shown.length === 0) {
    if (opensAddress) return null
    return (
      <EmptyState
        icon={<SearchIcon size={28} />}
        title="No apps found"
        body={`Nothing matches “${query.trim()}”. Try another name or web address.`}
      />
    )
  }
  const card = { currency, usdPerBsv, now }
  return view === 'grid' ? (
    <ul className="collection-grid">
      {shown.map((app) => (
        <AppGridItem key={app.origin} app={app} {...card} />
      ))}
    </ul>
  ) : (
    <ul className="connected-app-list">
      {shown.map((app) => (
        <AppListItem key={app.origin} app={app} {...card} />
      ))}
    </ul>
  )
}

export function ConnectedAppsPanel({ apps, openTabCount, onShowTabs }: Props) {
  const [usdPerBsv, setUsdPerBsv] = useState<number | null>(() => getCachedUsdPerBsv())
  const [currency, setCurrency] = useState<DisplayCurrency>(() => getDisplayCurrency())
  const [view, setView] = useState<CollectionView>(() => getCollectionView('apps'))
  const [tick, setTick] = useState(0)
  const [query, setQuery] = useState('')

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
  const now = useMemo(() => {
    void tick
    return Date.now()
  }, [tick, apps])

  const topMatch = useMemo(() => filterConnectedApps(orderedApps, query)[0] ?? null, [orderedApps, query])
  const compact = useSyncExternalStore(subscribeCompactLayout, isCompactLayout, isCompactLayout)
  const canOpen = canOpenAppAddresses(compact)
  const address = appsSearchAddress(query, canOpen)
  const showSearch = apps.length > 0 || canOpen

  return (
    <div
      className="nav-section-body nav-section-with-scroll"
      data-aeon-scope="connected-apps"
      data-aeon-state={view}
    >
      <ListPanelHead
        title="Connected apps"
        count={apps.length}
        countLabel={`${apps.length} connected ${apps.length === 1 ? 'app' : 'apps'}`}
        actions={
          <>
            <Button.Root
              variant="ghost"
              className="connected-app-tabs-button"
              aria-label={`Show ${openTabCount} open web ${openTabCount === 1 ? 'page' : 'pages'}`}
              title="Open web pages"
              disabled={openTabCount === 0}
              onClick={() => {
                playWalletSound('soft')
                onShowTabs()
              }}
            >
              <ViewGridIcon size={16} />
              <span>{openTabCount}</span>
            </Button.Root>
            <button
              type="button"
              className="panel-icon-btn"
              aria-label="Developer keys"
              title="Developer keys"
              onClick={() => {
                playWalletSound('soft')
                openDevKeys()
              }}
            >
              <CodeIcon size={16} />
            </button>
            {apps.length > 0 ? <CollectionViewToggle label="Connected apps view" scope="apps" /> : null}
          </>
        }
        search={
          showSearch ? (
            <AppsSearchBar query={query} onQueryChange={setQuery} topMatch={topMatch} canOpen={canOpen} />
          ) : null
        }
      />
      {apps.length === 0 ? (
        <ConnectedAppsResults
          apps={orderedApps}
          query={query}
          view={view}
          currency={currency}
          usdPerBsv={usdPerBsv}
          now={now}
          opensAddress={address !== null}
          canOpen={canOpen}
        />
      ) : (
        <div className="nav-section-scroll-body">
          <ConnectedAppsResults
            apps={orderedApps}
            query={query}
            view={view}
            currency={currency}
            usdPerBsv={usdPerBsv}
            now={now}
            opensAddress={address !== null}
            canOpen={canOpen}
          />
        </div>
      )}
    </div>
  )
}
