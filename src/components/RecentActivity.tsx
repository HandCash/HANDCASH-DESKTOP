import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { PaymentFiltersPanel } from './PaymentFiltersPanel'
import {
  ActivityIcon,
  CollectablesIcon,
  FilterIcon,
  ReceiveIcon,
  SendIcon,
} from './icons'
import { DeferredImage } from './DeferredImage'
import {
  activityEntryKey,
  activityEntryTitle,
  isItemActivity,
  listRecentActivity,
  subscribeAppActivity,
  type ActivityEntry,
} from '../wallet/appActivity'
import { markActivitySeen, shouldAnnounceActivity } from '../wallet/activitySeen'
import { viewActivityItem } from '../wallet/activityItemView'
import { subscribeCollectables } from '../wallet/collectables'
import bsvLogo from '../assets/brand/bsv-logo.png'
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

/** Paint a few rows per frame so Activity does not block the UI on open. */
const RENDER_CHUNK = 16

function useChunkedCount(total: number): number {
  const [shown, setShown] = useState(() => Math.min(RENDER_CHUNK, total))

  useEffect(() => {
    setShown(Math.min(RENDER_CHUNK, total))
    if (total <= RENDER_CHUNK) return

    let cancelled = false
    let next = RENDER_CHUNK
    let handle = 0

    const step = () => {
      if (cancelled) return
      next = Math.min(total, next + RENDER_CHUNK)
      setShown(next)
      if (next < total) handle = window.requestAnimationFrame(step)
    }

    handle = window.requestAnimationFrame(step)
    return () => {
      cancelled = true
      if (handle) window.cancelAnimationFrame(handle)
    }
  }, [total])

  return shown
}

type ActivityFeedSnapshot = {
  entries: ActivityEntry[]
  origins: PaymentOriginOption[]
}

const feedCache = new Map<number, ActivityFeedSnapshot>()

function readActivityFeed(limit: number): ActivityFeedSnapshot {
  const hit = feedCache.get(limit)
  if (hit) return hit
  const snapshot = {
    entries: listRecentActivity(limit),
    origins: listPaymentOriginOptions(limit),
  }
  feedCache.set(limit, snapshot)
  return snapshot
}

function invalidateActivityFeed(limit?: number): void {
  if (limit == null) feedCache.clear()
  else feedCache.delete(limit)
}

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
  newest = false,
}: {
  entry: ActivityEntry
  currency: DisplayCurrency
  usdPerBsv: number | null
  showWhen: boolean
  newest?: boolean
}) {
  const spent = entry.kind === 'spent'
  const item = isItemActivity(entry)
  // Identity as the wallet knows it now, not as the row froze it on arrival.
  const shown = entry.item ? viewActivityItem(entry.item) : undefined
  const title = activityEntryTitle(shown ? { ...entry, item: shown } : entry)
  const amountLabel = item
    ? shown?.name || 'Collectable'
    : formatPrimaryFromSats(entry.sats, currency, usdPerBsv)
  const signed = item
    ? 'Item'
    : currency === 'usd' && usdPerBsv == null
      ? '—'
      : spent
        ? `−${amountLabel}`
        : `+${amountLabel}`

  return (
    <li data-activity-newest={newest ? '' : undefined}>
      <button
        type="button"
        className="history-row history-row-btn"
        onClick={() => {
          playWalletSound('soft')
          openPaymentDetails(entry.id)
        }}
      >
        <div className="history-icon-wrap">
          <div className="history-icon">
            {item && shown?.imageUrl ? (
              <DeferredImage
                className="history-item-thumb"
                src={shown.imageUrl}
                alt=""
                width={28}
                height={28}
                skeletonWidth={28}
                skeletonHeight={28}
                skeletonRadius={6}
                decoding="async"
              />
            ) : item ? (
              <span className="history-item-thumb-icon">
                <CollectablesIcon size={18} />
              </span>
            ) : (
              <img className="history-asset-logo" src={bsvLogo} alt="" width={32} height={32} />
            )}
          </div>
          <span
            className={`history-action-badge ${spent ? 'is-send' : 'is-receive'}`}
            aria-label={spent ? 'Send' : 'Receive'}
            title={spent ? 'Send' : 'Receive'}
          >
            {spent ? <SendIcon size={6.75} /> : <ReceiveIcon size={9} />}
          </span>
        </div>
        <div className="history-body">
          <strong className="history-title">{title}</strong>
          {item && shown?.app ? <span className="history-when">{shown.app}</span> : null}
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
  const [entries, setEntries] = useState<ActivityEntry[]>(() => readActivityFeed(limit).entries)
  const [usdPerBsv, setUsdPerBsv] = useState<number | null>(() => getCachedUsdPerBsv())
  const [currency, setCurrency] = useState<DisplayCurrency>(() => getDisplayCurrency())
  const [origins, setOrigins] = useState<PaymentOriginOption[]>(() => readActivityFeed(limit).origins)

  useEffect(() => subscribeUsdRate(setUsdPerBsv), [])
  useEffect(() => subscribeDisplayCurrency(setCurrency), [])
  useEffect(() => {
    const refresh = () => {
      invalidateActivityFeed(limit)
      const snapshot = readActivityFeed(limit)
      setEntries(snapshot.entries)
      setOrigins(snapshot.origins)
    }
    const unsubActivity = subscribeAppActivity(refresh)
    const unsubApps = subscribeConnectedApps(refresh)
    // A repaired collectable changes what item rows should show, so pick it up
    // rather than waiting for the next unrelated render.
    const unsubItems = subscribeCollectables(refresh)
    return () => {
      unsubActivity()
      unsubApps()
      unsubItems()
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

/**
 * Keep newest rows in view when the feed is at its default (top) scroll.
 *
 * The flash announces a transaction that just landed and has not been shown
 * before, decided from the durable seen record keyed by event identity plus the
 * entry's own age. Opening Activity, flicking between tabs, or reopening the app
 * all re-mount the feed over entries the user has already read, and none of
 * those are arrivals.
 */
function useStickNewestToTop(
  listRef: RefObject<HTMLElement | null>,
  newest: { key: string; at: number } | undefined,
  shownKeys: readonly string[],
) {
  const stickToTopRef = useRef(true)

  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const onScroll = () => {
      stickToTopRef.current = el.scrollTop <= 24
    }
    onScroll()
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [listRef])

  useEffect(() => {
    const el = listRef.current
    if (!el || !newest) return

    const fresh = shouldAnnounceActivity(newest.key, newest.at)
    markActivitySeen(shownKeys)
    if (!fresh || !stickToTopRef.current) return

    const pin = () => {
      el.scrollTop = 0
      stickToTopRef.current = true
      const row = el.querySelector<HTMLElement>('[data-activity-newest]')
      if (!row) return
      row.classList.remove('is-fresh')
      // Restart CSS animation if another arrival lands quickly.
      void row.offsetWidth
      row.classList.add('is-fresh')
    }
    pin()
    const raf = window.requestAnimationFrame(pin)
    return () => window.cancelAnimationFrame(raf)
  }, [listRef, newest, shownKeys])
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
  const shownCount = useChunkedCount(filtered.length)
  const visibleEntries = filtered.slice(0, shownCount)
  const newest = useMemo(() => {
    const top = filtered[0]
    return top ? { key: activityEntryKey(top), at: top.at } : undefined
  }, [filtered])
  const shownKeys = useMemo(() => filtered.map(activityEntryKey), [filtered])
  useStickNewestToTop(listRef, newest, shownKeys)

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
        {visibleEntries.map((entry, index) => (
          <HistoryRow
            key={entry.id}
            entry={entry}
            currency={currency}
            usdPerBsv={usdPerBsv}
            showWhen={showWhen}
            newest={index === 0}
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
