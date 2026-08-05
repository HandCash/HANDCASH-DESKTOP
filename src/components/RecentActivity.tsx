import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { AppAvatar } from './AppAvatar'
import { PaymentFiltersPanel } from './PaymentFiltersPanel'
import { ActivityIcon, FilterIcon, ReceiveIcon, SendIcon } from './icons'
import { appDisplayName } from '../wallet/appIdentity'
import {
  activityEntryTitle,
  isItemActivity,
  listRecentActivity,
  subscribeAppActivity,
  WALLET_ACTIVITY_ORIGIN,
  type ActivityEntry,
} from '../wallet/appActivity'
import {
  DEFAULT_PAYMENT_FILTERS,
  filterPaymentActivity,
  listPaymentOriginOptions,
  type PaymentFilters,
  type PaymentOriginOption,
} from '../wallet/paymentFilters'
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
import { subscribeConnectedApps } from '../wallet/permissions'
import { openPaymentDetails, setNavSection } from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import type { Chain } from '../wallet/vault'
import { EmptyState } from './EmptyState'
import { DeferredImage } from './DeferredImage'

function formatWhen(at: number): string {
  const diff = Math.max(0, Date.now() - at)
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return 'Just now'
  if (minutes === 1) return '1 minute ago'
  if (minutes < 60) return `${minutes} minutes ago`

  const hours = Math.floor(minutes / 60)
  if (hours === 1) return '1 hour ago'
  if (hours < 24) return `${hours} hours ago`

  const days = Math.floor(hours / 24)
  if (days === 1) return '1 day ago'
  if (days < 30) return `${days} days ago`

  const months = Math.floor(days / 30)
  if (months === 1) return '1 month ago'
  if (months < 12) return `${months} months ago`

  const years = Math.floor(days / 365)
  if (years === 1) return '1 year ago'
  return `${years} years ago`
}

function HistoryRow({
  entry,
  currency,
  usdPerBsv,
  showWhen,
}: {
  entry: ActivityEntry
  currency: DisplayCurrency
  usdPerBsv: number | null
  showWhen: boolean
}) {
  const isWallet = entry.origin === WALLET_ACTIVITY_ORIGIN
  const spent = entry.kind === 'spent'
  const item = isItemActivity(entry)
  const title = activityEntryTitle(entry)
  const amountLabel = item
    ? entry.item?.name || 'Collectable'
    : formatPrimaryFromSats(entry.sats, currency, usdPerBsv)
  const signed = item
    ? 'Item'
    : currency === 'usd' && usdPerBsv == null
      ? '—'
      : spent
        ? `−${amountLabel}`
        : `+${amountLabel}`

  return (
    <li>
      <button
        type="button"
        className="history-row history-row-btn"
        onClick={() => {
          playWalletSound('soft')
          openPaymentDetails(entry.id)
        }}
      >
        <div className="history-icon">
          {item && entry.item?.imageUrl ? (
            // Ordinal content is full size whatever we display it at, so keep the
            // decode off the main thread — a list of them freezes a phone.
            <DeferredImage
              className="history-item-thumb"
              src={entry.item.imageUrl}
              alt=""
              width={28}
              height={28}
              skeletonWidth={28}
              skeletonHeight={28}
              skeletonRadius={6}
              loading="lazy"
              decoding="async"
            />
          ) : isWallet ? (
            spent ? <SendIcon size={14} /> : <ReceiveIcon size={14} />
          ) : (
            <AppAvatar
              origin={entry.origin}
              name={appDisplayName(entry.origin)}
              size="sm"
            />
          )}
        </div>
        <div className="history-body">
          <strong className="history-title">{title}</strong>
          {item && entry.item?.app ? (
            <span className="history-when">{entry.item.app}</span>
          ) : null}
        </div>
        <div className="history-amount-block">
          <span
            className={item ? 'history-amount history-amount-item' : 'history-amount'}
            title={amountLabel}
          >
            {signed}
          </span>
          {showWhen ? <span className="history-when">{formatWhen(entry.at)}</span> : null}
        </div>
      </button>
    </li>
  )
}

type FeedProps = {
  chain?: Chain
  limit?: number
  title?: string
  embedded?: boolean
  emptyLabel?: string
  showCount?: boolean
  showFilters?: boolean
  showWhen?: boolean
  /** Footer CTA under the list (dashboard recent activity). */
  viewAllLabel?: string
  onViewAll?: () => void
}

function useActivityFeed(limit: number) {
  const [entries, setEntries] = useState<ActivityEntry[]>(() => listRecentActivity(limit))
  const [usdPerBsv, setUsdPerBsv] = useState<number | null>(() => getCachedUsdPerBsv())
  const [currency, setCurrency] = useState<DisplayCurrency>(() => getDisplayCurrency())
  const [origins, setOrigins] = useState<PaymentOriginOption[]>(() => listPaymentOriginOptions(limit))

  useEffect(() => subscribeUsdRate(setUsdPerBsv), [])
  useEffect(() => subscribeDisplayCurrency(setCurrency), [])
  useEffect(() => {
    const refresh = () => {
      setEntries(listRecentActivity(limit))
      setOrigins(listPaymentOriginOptions(limit))
    }
    const unsubActivity = subscribeAppActivity(refresh)
    const unsubApps = subscribeConnectedApps(refresh)
    return () => {
      unsubActivity()
      unsubApps()
    }
  }, [limit])

  return { entries, usdPerBsv, currency, origins }
}

function useScrollReveal(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let timer = 0
    const onScroll = () => {
      el.classList.add('is-scrolling')
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        el.classList.remove('is-scrolling')
      }, 700)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      window.clearTimeout(timer)
    }
  }, [ref])
}

export function ActivityFeed({
  limit = 40,
  title = 'Recent activity',
  embedded = false,
  emptyLabel = 'No activity yet',
  showCount = true,
  showFilters = false,
  showWhen = false,
  viewAllLabel,
  onViewAll,
}: FeedProps) {
  const { entries, usdPerBsv, currency, origins } = useActivityFeed(limit)
  const [filters, setFilters] = useState<PaymentFilters>(DEFAULT_PAYMENT_FILTERS)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const listRef = useRef<HTMLUListElement>(null)
  useScrollReveal(listRef)

  const filtered = useMemo(
    () => (showFilters ? filterPaymentActivity(entries, filters) : entries),
    [entries, filters, showFilters],
  )

  const filtersActive =
    filters.kind !== DEFAULT_PAYMENT_FILTERS.kind ||
    filters.time !== DEFAULT_PAYMENT_FILTERS.time ||
    filters.origin !== DEFAULT_PAYMENT_FILTERS.origin

  // Drop a selected app filter if that origin disappears.
  useEffect(() => {
    if (filters.origin === 'all') return
    if (origins.some((o) => o.id === filters.origin)) return
    setFilters((prev) => ({ ...prev, origin: 'all' }))
  }, [origins, filters.origin])

  const body =
    filtered.length === 0 ? (
      <EmptyState
        icon={<ActivityIcon size={28} />}
        title={entries.length === 0 ? emptyLabel : 'Nothing matches'}
        body={
          entries.length === 0
            ? 'Sends, receives, and app payments will show up here.'
            : 'Try clearing filters to see more activity.'
        }
      />
    ) : (
      <ul className="history-list" ref={listRef}>
        {filtered.map((entry) => (
          <HistoryRow
            key={entry.id}
            entry={entry}
            currency={currency}
            usdPerBsv={usdPerBsv}
            showWhen={showWhen}
          />
        ))}
        {viewAllLabel && onViewAll ? (
          <li className="history-view-all-row">
            <button
              type="button"
              className="history-view-all"
              onClick={() => {
                playWalletSound('soft')
                onViewAll()
              }}
            >
              {viewAllLabel}
            </button>
          </li>
        ) : null}
      </ul>
    )

  const head = (
    <div className="connected-panel-head">
      <h2>{title}</h2>
      <div className="connected-panel-head-actions">
        {showCount ? <span className="connected-count">{filtered.length}</span> : null}
        {showFilters ? (
          <button
            type="button"
            className="activity-filter-toggle"
            aria-label={filtersOpen ? 'Hide filters' : 'Show filters'}
            aria-expanded={filtersOpen}
            aria-controls="activity-filters"
            title="Filters"
            data-active={filtersOpen || filtersActive ? '' : undefined}
            onClick={() => {
              playWalletSound('soft')
              setFiltersOpen((open) => !open)
            }}
          >
            <FilterIcon size={16} />
            {filtersActive ? <span className="activity-filter-dot" aria-hidden /> : null}
          </button>
        ) : null}
      </div>
    </div>
  )

  const filtersPanel =
    showFilters && filtersOpen ? (
      <PaymentFiltersPanel
        id="activity-filters"
        value={filters}
        origins={origins}
        onChange={setFilters}
      />
    ) : null

  if (embedded) {
    return (
      <div
        className={
          showFilters
            ? `history-embedded history-with-filters${filtersOpen ? ' filters-open' : ''}`
            : 'history-embedded'
        }
        data-aeon-scope="activity-feed"
        data-aeon-state={filtersOpen ? 'filters-open' : 'filters-closed'}
      >
        {head}
        {filtersPanel}
        {body}
      </div>
    )
  }

  return (
    <section className="history-panel panel" data-aeon-scope="recent-activity">
      {head}
      {filtersPanel}
      {body}
    </section>
  )
}

/** Side column feed. */
export function RecentActivityPanel({ chain }: { chain?: Chain }) {
  return (
    <ActivityFeed
      chain={chain}
      title="Recent activity"
      limit={15}
      showCount={false}
      viewAllLabel="View full activity"
      onViewAll={() => setNavSection('activity')}
    />
  )
}

/** Full activity tab. */
export function TransactionsPanel({ chain }: { chain?: Chain }) {
  return (
    <ActivityFeed
      chain={chain}
      title="Activity"
      limit={200}
      embedded
      emptyLabel="No activity yet"
      showCount={false}
      showFilters
      showWhen
    />
  )
}
