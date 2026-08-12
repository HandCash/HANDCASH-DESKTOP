import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { PaymentFiltersPanel } from './PaymentFiltersPanel'
import {
  ActivityIcon,
  AppsIcon,
  CollectablesIcon,
  FilterIcon,
  FriendsIcon,
  MintIcon,
  ReceiveIcon,
  SendIcon,
} from './icons'
import { DeferredImage } from './DeferredImage'
import { CollectableVerifyMark } from './CollectableVerifyMark'
import {
  activityEntryKey,
  activityEntryTitle,
  activityTokenAmountDisplay,
  expireStaleInboundPending,
  getActivityWriteGeneration,
  isEventActivity,
  isItemActivity,
  isMintTokenActivity,
  isTokenActivity,
  isPendingActivity,
  listRecentActivity,
  subscribeAppActivity,
  WALLET_ACTIVITY_ORIGIN,
  type ActivityEntry,
} from '../wallet/appActivity'
import {
  markActivitySeen,
  noteActivityAnnounced,
  shouldAnnounceActivity,
} from '../wallet/activitySeen'
import { viewActivityItem } from '../wallet/activityItemView'
import { getCachedCollectables, subscribeCollectables } from '../wallet/collectables'
import { subscribeFungibles } from '../wallet/fungibles'
import {
  getVerificationProgress,
  isOutpointVerifying,
  subscribeVerificationProgress,
} from '../wallet/verificationProgress'
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
import {
  getPaymentProgress,
  subscribePaymentProgress,
  type PaymentProgress,
} from '../wallet/paymentProgress'
import { openPaymentDetails, setNavSection } from '../wallet/navStore'
import { subscribeConnectedApps } from '../wallet/permissions'
import { playWalletSound } from '../wallet/soundService'
import type { Chain } from '../wallet/vault'
import { EmptyState } from './EmptyState'

/** Paint a few rows per frame so Activity does not block the UI on open. */
const RENDER_CHUNK = 24

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
  generation: number
  entries: ActivityEntry[]
  origins: PaymentOriginOption[]
}

const feedCache = new Map<number, ActivityFeedSnapshot>()

function readActivityFeed(limit: number): ActivityFeedSnapshot {
  const generation = getActivityWriteGeneration()
  const hit = feedCache.get(limit)
  if (hit && hit.generation === generation) return hit
  const snapshot = {
    generation,
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
  verifying = false,
}: {
  entry: ActivityEntry
  currency: DisplayCurrency
  usdPerBsv: number | null
  showWhen: boolean
  newest?: boolean
  verifying?: boolean
}) {
  const spent = entry.kind === 'spent'
  const event = isEventActivity(entry)
  const item = isItemActivity(entry)
  const token = isTokenActivity(entry)
  const minted = isMintTokenActivity(entry)
  const pending = isPendingActivity(entry)
  const inventoryProven = Boolean(
    entry.item?.outpoint &&
      getCachedCollectables().some(
        (c) =>
          c.proven === true &&
          c.outpoint.trim().toLowerCase().replace(/_(\d+)$/, '.$1') ===
            entry.item!.outpoint!.trim().toLowerCase().replace(/_(\d+)$/, '.$1'),
      ),
  )
  const showPending = pending && (spent || !inventoryProven)
  const pendingLabel = spent ? 'Sending…' : 'Verifying…'
  // Identity as the wallet knows it now, not as the row froze it on arrival.
  const shown = entry.item ? viewActivityItem(entry.item) : undefined
  const title = activityEntryTitle(shown ? { ...entry, item: shown } : entry)
  const amountLabel = event
    ? eventAmountLabel(entry)
    : token
      ? activityTokenAmountDisplay(shown ? { ...entry, item: shown } : entry)
      : item
        ? shown?.name || 'Collectable'
        : showPending && entry.sats <= 0
          ? '…'
          : formatPrimaryFromSats(entry.sats, currency, usdPerBsv)
  const signed = event
    ? amountLabel
    : token
      ? amountLabel
      : item
        ? 'Item'
        : currency === 'usd' && usdPerBsv == null
          ? '—'
          : spent
            ? `−${amountLabel}`
            : `+${amountLabel}`
  const subtitle = event
    ? entry.origin !== WALLET_ACTIVITY_ORIGIN
      ? entry.origin
      : null
    : item && shown?.app
      ? shown.app
      : null

  const entryKey = activityEntryKey(entry)
  const showVerify = Boolean(
    !spent && !event && !inventoryProven && (showPending || (item && verifying)),
  )
  const badgeKind = minted ? 'mint' : spent ? 'send' : 'receive'
  const badgeLabel = minted ? 'Mint' : spent ? 'Send' : 'Receive'

  return (
    <li
      data-activity-key={entryKey}
      data-activity-newest={newest ? '' : undefined}
      data-activity-pending={showPending ? '' : undefined}
    >
      <button
        type="button"
        className="history-row history-row-btn"
        onClick={() => {
          if (entry.id === LIVE_OUTBOUND_ID) return
          playWalletSound('soft')
          openPaymentDetails(entry.id)
        }}
      >
        <div className="history-icon-wrap">
          <div className="history-icon">
            {event ? (
              <span className="history-item-thumb-icon" aria-hidden>
                {eventIcon(entry)}
              </span>
            ) : item && shown?.imageUrl ? (
              <DeferredImage
                className="history-item-thumb"
                src={shown.imageUrl}
                alt=""
                width={28}
                height={28}
                skeletonWidth={28}
                skeletonHeight={28}
                skeletonRadius={6}
                retainDecoded
                decoding="async"
                fallback={
                  <span className="history-item-thumb-icon">
                    <CollectablesIcon size={18} />
                  </span>
                }
              />
            ) : item ? (
              <span className="history-item-thumb-icon">
                <CollectablesIcon size={18} />
              </span>
            ) : (
              <img className="history-asset-logo" src={bsvLogo} alt="" width={32} height={32} />
            )}
          </div>
          <CollectableVerifyMark
            verifying={showVerify}
            outpoint={entry.item?.outpoint}
          />
          {!event ? (
            <span
              className={`history-action-badge is-${badgeKind}`}
              aria-label={badgeLabel}
              title={badgeLabel}
            >
              {minted ? (
                <MintIcon size={8} />
              ) : spent ? (
                <SendIcon size={6.75} />
              ) : (
                <ReceiveIcon size={9} />
              )}
            </span>
          ) : null}
        </div>
        <div className="history-body">
          <strong className="history-title">{title}</strong>
          {subtitle ? <span className="history-when">{subtitle}</span> : null}
        </div>
        <div className="history-amount-block">
          <span
            className={
              event || item
                ? 'history-amount history-amount-item'
                : 'history-amount'
            }
            title={amountLabel}
          >
            {signed}
          </span>
          {showWhen ? (
            <span className="history-when">
              {showPending ? pendingLabel : formatWhen(entry.at)}
            </span>
          ) : null}
        </div>
      </button>
    </li>
  )
}

function eventAmountLabel(entry: ActivityEntry): string {
  const m = entry.method
  if (m === 'connect' || m === 'approve') return 'Allowed'
  if (m === 'connect-deny' || m === 'deny') return 'Denied'
  if (m === 'disconnect') return 'Removed'
  if (m === 'add-friend') return 'Friend'
  return 'Action'
}

function eventIcon(entry: ActivityEntry) {
  const m = entry.method
  if (m === 'add-friend') return <FriendsIcon size={18} />
  if (m.startsWith('connect') || m === 'disconnect' || m === 'approve' || m === 'deny') {
    return <AppsIcon size={18} />
  }
  return <ActivityIcon size={18} />
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

const LIVE_OUTBOUND_ID = 'live-outbound-send'

/** Top-of-feed row while paymentProgress is active and durable pending is late. */
function liveOutboundActivityEntry(progress: PaymentProgress): ActivityEntry {
  return {
    id: LIVE_OUTBOUND_ID,
    origin: WALLET_ACTIVITY_ORIGIN,
    kind: 'spent',
    sats: 0,
    at: Date.now(),
    method: progress.outpoint ? 'send-collectable' : 'send',
    note: progress.detail || 'Sending…',
    status: 'pending',
    pendingId: LIVE_OUTBOUND_ID,
    ...(progress.outpoint
      ? {
          item: {
            name: 'Collectable',
            origin: progress.outpoint.replace(/_/g, '.'),
            outpoint: progress.outpoint.replace(/_/g, '.'),
          },
        }
      : {}),
  }
}

function mergeLiveOutbound(
  entries: ActivityEntry[],
  progress: PaymentProgress,
): ActivityEntry[] {
  if (progress.phase === 'idle' || progress.phase === 'finishing') {
    return entries.filter((e) => e.id !== LIVE_OUTBOUND_ID)
  }
  if (entries.some((e) => e.status === 'pending' && e.kind === 'spent')) {
    return entries.filter((e) => e.id !== LIVE_OUTBOUND_ID)
  }
  return [liveOutboundActivityEntry(progress), ...entries]
}

function useActivityFeed(limit: number) {
  const [entries, setEntries] = useState<ActivityEntry[]>(() => readActivityFeed(limit).entries)
  const [usdPerBsv, setUsdPerBsv] = useState<number | null>(() => getCachedUsdPerBsv())
  const [currency, setCurrency] = useState<DisplayCurrency>(() => getDisplayCurrency())
  const [origins, setOrigins] = useState<PaymentOriginOption[]>(() => readActivityFeed(limit).origins)
  const [payment, setPayment] = useState<PaymentProgress>(() => getPaymentProgress())

  useEffect(() => subscribeUsdRate(setUsdPerBsv), [])
  useEffect(() => subscribeDisplayCurrency(setCurrency), [])
  useEffect(() => subscribePaymentProgress(setPayment), [])
  useEffect(() => {
    const refresh = () => {
      expireStaleInboundPending()
      invalidateActivityFeed(limit)
      const snapshot = readActivityFeed(limit)
      setEntries(snapshot.entries)
      setOrigins(snapshot.origins)
    }
    refresh()
    const unsubActivity = subscribeAppActivity(refresh)
    const unsubApps = subscribeConnectedApps(refresh)
    // A repaired collectable / resolved token icon changes what item rows show.
    const unsubItems = subscribeCollectables(refresh)
    const unsubTokens = subscribeFungibles(refresh)
    return () => {
      unsubActivity()
      unsubApps()
      unsubItems()
      unsubTokens()
    }
  }, [limit])

  const merged = useMemo(
    () => mergeLiveOutbound(entries, payment),
    [entries, payment],
  )

  return { entries: merged, usdPerBsv, currency, origins }
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
  // Stable fingerprint so collectables healing the feed cannot re-fire the
  // announce effect and restart the top-row animation on every inventory tick.
  const shownFingerprint = shownKeys.join('\0')

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
    if (!el) return
    if (!newest) {
      if (shownKeys.length > 0) markActivitySeen(shownKeys)
      return
    }

    const fresh = shouldAnnounceActivity(newest.key, newest.at)
    // Whether we flash or not, this key is decided for the session — tab
    // switches must not re-evaluate a tip still inside the recency window.
    noteActivityAnnounced(newest.key)
    markActivitySeen(shownKeys)
    if (!fresh || !stickToTopRef.current) return

    let clearFresh: number | undefined
    const pin = () => {
      el.scrollTop = 0
      stickToTopRef.current = true
      const row = el.querySelector<HTMLElement>(
        `[data-activity-key="${CSS.escape(newest.key)}"]`,
      )
      if (!row) return
      row.classList.remove('is-fresh')
      // Restart CSS animation if another arrival lands quickly.
      void row.offsetWidth
      row.classList.add('is-fresh')
      // Drop the class when the animation ends. Leaving `is-fresh` on a
      // keep-alive Activity panel restarts the highlight every time the tab is
      // un-hidden — that was the remaining top-row flash.
      window.clearTimeout(clearFresh)
      clearFresh = window.setTimeout(() => {
        row.classList.remove('is-fresh')
      }, 780)
    }
    pin()
    const raf = window.requestAnimationFrame(pin)
    return () => {
      window.cancelAnimationFrame(raf)
      window.clearTimeout(clearFresh)
    }
    // shownFingerprint stands in for shownKeys identity without array churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listRef, newest?.key, newest?.at, shownFingerprint])
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
  const [verification, setVerification] = useState(() => getVerificationProgress())
  const listRef = useRef<HTMLUListElement>(null)
  useScrollReveal(listRef)
  useEffect(() => subscribeVerificationProgress(setVerification), [])

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
            ? 'Sends, receives, connections, and other wallet actions show up here.'
            : 'Try clearing filters to see more activity.'
        }
      />
    ) : (
      <ul className="history-list" ref={listRef}>
        {visibleEntries.map((entry, index) => (
          <HistoryRow
            key={activityEntryKey(entry)}
            entry={entry}
            currency={currency}
            usdPerBsv={usdPerBsv}
            showWhen={showWhen}
            newest={index === 0}
            verifying={
              !(
                entry.item?.outpoint &&
                getCachedCollectables().some(
                  (c) =>
                    c.proven === true &&
                    c.outpoint.trim().toLowerCase().replace(/_(\d+)$/, '.$1') ===
                      entry.item!.outpoint!.trim().toLowerCase().replace(/_(\d+)$/, '.$1'),
                )
              ) &&
              (isPendingActivity(entry) ||
                isOutpointVerifying(entry.item?.outpoint, verification))
            }
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
