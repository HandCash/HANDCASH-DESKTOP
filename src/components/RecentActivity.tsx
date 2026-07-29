import { useEffect, useState } from 'react'
import { AppAvatar } from './AppAvatar'
import { ReceiveIcon, SendIcon } from './icons'
import { appDisplayName } from '../wallet/appIdentity'
import {
  listRecentActivity,
  subscribeAppActivity,
  WALLET_ACTIVITY_ORIGIN,
  type ActivityEntry,
} from '../wallet/appActivity'
import {
  formatUsdFromSats,
  getCachedUsdPerBsv,
  subscribeUsdRate,
} from '../wallet/fx'
import { getActiveWallet } from '../wallet/session'
import { isExplorerTxid, txExplorerUrl } from '../wallet/txExplorer'
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
  usdPerBsv,
  chain,
}: {
  entry: ActivityEntry
  usdPerBsv: number | null
  chain: Chain
}) {
  const isWallet = entry.origin === WALLET_ACTIVITY_ORIGIN
  const spent = entry.kind === 'spent'
  const amountLabel = formatUsdFromSats(entry.sats, usdPerBsv)
  const signed =
    usdPerBsv == null ? '—' : spent ? `−${amountLabel}` : `+${amountLabel}`
  const href = isExplorerTxid(entry.txid) ? txExplorerUrl(entry.txid, chain) : null

  const inner = (
    <>
      <div className={`history-icon ${spent ? 'history-icon-out' : 'history-icon-in'}`}>
        {isWallet ? (
          spent ? <SendIcon size={14} /> : <ReceiveIcon size={14} />
        ) : (
          <AppAvatar origin={entry.origin} name={appDisplayName(entry.origin)} size="sm" />
        )}
      </div>
      <div className="history-body">
        <strong className="history-title">{entryTitle(entry)}</strong>
        <span className="history-when">{formatWhen(entry.at)}</span>
      </div>
      <span className={`history-amount ${spent ? 'history-out' : 'history-in'}`} title={amountLabel}>
        {signed}
      </span>
    </>
  )

  if (href) {
    return (
      <li>
        <a
          className="history-row history-row-link"
          href={href}
          target="_blank"
          rel="noreferrer"
          title="Open in WhatsOnChain"
        >
          {inner}
        </a>
      </li>
    )
  }

  return (
    <li>
      <div className="history-row">{inner}</div>
    </li>
  )
}

type FeedProps = {
  chain?: Chain
  /** How many newest entries to show. */
  limit?: number
  title?: string
  /** When true, render without outer panel chrome (for tab bodies). */
  embedded?: boolean
  emptyLabel?: string
  showCount?: boolean
}

function useActivityFeed(limit: number) {
  const [entries, setEntries] = useState<ActivityEntry[]>(() => listRecentActivity(limit))
  const [usdPerBsv, setUsdPerBsv] = useState<number | null>(() => getCachedUsdPerBsv())

  useEffect(() => subscribeUsdRate(setUsdPerBsv), [])
  useEffect(
    () =>
      subscribeAppActivity(() => {
        setEntries(listRecentActivity(limit))
      }),
    [limit],
  )

  return { entries, usdPerBsv }
}

export function ActivityFeed({
  chain,
  limit = 40,
  title = 'Recent activity',
  embedded = false,
  emptyLabel = 'No payments yet',
  showCount = true,
}: FeedProps) {
  const { entries, usdPerBsv } = useActivityFeed(limit)
  const resolvedChain = chain ?? getActiveWallet()?.chain ?? 'main'

  const body =
    entries.length === 0 ? (
      <p className="connected-empty-line">{emptyLabel}</p>
    ) : (
      <ul className="history-list">
        {entries.map((entry) => (
          <HistoryRow
            key={entry.id}
            entry={entry}
            usdPerBsv={usdPerBsv}
            chain={resolvedChain}
          />
        ))}
      </ul>
    )

  const head = (
    <div className="connected-panel-head">
      <h2>{title}</h2>
      {showCount ? <span className="connected-count">{entries.length}</span> : null}
    </div>
  )

  if (embedded) {
    return (
      <div className="history-embedded" data-aeon-scope="activity-feed">
        {head}
        {body}
      </div>
    )
  }

  return (
    <section className="history-panel panel" data-aeon-scope="recent-activity">
      {head}
      {body}
    </section>
  )
}

/** Side column feed. */
export function RecentActivityPanel({ chain }: { chain?: Chain }) {
  return <ActivityFeed chain={chain} title="Recent activity" limit={40} />
}

/** Full payments tab. */
export function TransactionsPanel({ chain }: { chain?: Chain }) {
  return (
    <ActivityFeed
      chain={chain}
      title="Payments"
      limit={200}
      embedded
      emptyLabel="No payments yet"
      showCount={false}
    />
  )
}
