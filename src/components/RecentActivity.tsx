import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { AppAvatar } from './AppAvatar'
import { PaymentFiltersPanel } from './PaymentFiltersPanel'
import { FilterIcon, ReceiveIcon, SendIcon } from './icons'
import { SkeletonHistoryRow } from './Skeleton'
import { appDisplayName } from '../wallet/appIdentity'
import {
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
import { openPaymentDetails } from '../wallet/navStore'
import type { Chain } from '../wallet/vault'

function formatWhen(at: number): string {
  const d = new Date(at)
  const now = Date.now()
  const diff = now - at
  if (diff < 60_000) return 'Just now'
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / (60 * 60_000))}h ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function entryTitle(entry: ActivityEntry): string {
  if (entry.origin === WALLET_ACTIVITY_ORIGIN) {
    return entry.kind === 'spent' ? 'Sent' : 'Received'
  }
  const name = appDisplayName(entry.origin)
  if (entry.kind === 'spent') return entry.note?.trim() || `Paid ${name}`
  return entry.note?.trim() || `From ${name}`
}

function HistoryRow({
  entry,
  currency,
  usdPerBsv,
}: {
  entry: ActivityEntry
  currency: DisplayCurrency
  usdPerBsv: number | null
}) {
  const isWallet = entry.origin === WALLET_ACTIVITY_ORIGIN
  const [ready, setReady] = useState(isWallet)
  const spent = entry.kind === 'spent'
  const amountLabel = formatPrimaryFromSats(entry.sats, currency, usdPerBsv)
  const signed =
    currency === 'usd' && usdPerBsv == null
      ? '—'
      : spent
        ? `−${amountLabel}`
        : `+${amountLabel}`

  return (
    <li data-ready={ready ? true : undefined}>
      {!ready ? <SkeletonHistoryRow /> : null}
      <button
        type="button"
        className={ready ? 'history-row history-row-btn' : 'media-preload'}
        tabIndex={ready ? 0 : -1}
        onClick={() => openPaymentDetails(entry.id)}
      >
        <div className="history-icon">
          {isWallet ? (
            spent ? <SendIcon size={14} /> : <ReceiveIcon size={14} />
          ) : (
            <AppAvatar
              origin={entry.origin}
              name={appDisplayName(entry.origin)}
              size="sm"
              onReady={() => setReady(true)}
            />
          )}
        </div>
        <div className="history-body">
          <strong className="history-title">{entryTitle(entry)}</strong>
          <span className="history-when">{formatWhen(entry.at)}</span>
        </div>
        <span className="history-amount" title={amountLabel}>
          {signed}
        </span>
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
      <p className="connected-empty-line">
        {entries.length === 0 ? emptyLabel : 'No activity matches these filters'}
      </p>
    ) : (
      <ul className="history-list" ref={listRef}>
        {filtered.map((entry) => (
          <HistoryRow
            key={entry.id}
            entry={entry}
            currency={currency}
            usdPerBsv={usdPerBsv}
          />
        ))}
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
            onClick={() => setFiltersOpen((open) => !open)}
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
  return <ActivityFeed chain={chain} title="Recent activity" limit={40} />
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
    />
  )
}
