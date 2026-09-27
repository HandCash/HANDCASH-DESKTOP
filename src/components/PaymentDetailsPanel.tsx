import { useEffect, useState } from 'react'
import { useActivityAction } from '../hooks/useActivityAction'
import { ActivityActionPrompt } from './ActivityActionPrompt'
import { AppAvatar } from './AppAvatar'
import { ReceiveIcon } from './icons'
import { HistoryActionBadge, HistoryAppBadge, HistoryIconCluster } from './RecentActivity'
import { appDisplayName } from '../wallet/appIdentity'
import {
  activityEntryKey,
  activityDetailLabel,
  activityEntryTitle,
  activityRecipientLabel,
  activityTokenAmountDisplay,
  getActivityById,
  isEventActivity,
  isFailedActivity,
  isFailedMarketListingActivity,
  activityFailureLabel,
  isItemActivity,
  isMintCollectableActivity,
  isMintTokenActivity,
  isPendingActivity,
  isTokenActivity,
  listRecentActivity,
  sameActivityRow,
  subscribeAppActivity,
  WALLET_ACTIVITY_ORIGIN,
  type ActivityEntry,
  type ActivityItem,
} from '../wallet/appActivity'
import { inFlightSettlementLabel } from '../wallet/settlementCopy'
import { getTxByTxid } from '../wallet/txStore'
import { viewActivityItem } from '../wallet/activityItemView'
import { activityContactLink } from '../wallet/itemHistory'
import {
  activityBatchName,
  activityBatchOf,
  composeActivityRecords,
  moneyLegForEntry,
} from '../wallet/activityRecords'
import {
  activityActionMark,
} from '../wallet/activityActionMark'
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
import { isExplorerTxid, txExplorerUrl } from '../wallet/txExplorer'
import type { Chain } from '../wallet/vault'
import { DeferredImage } from './DeferredImage'
import {
  getCachedCollectables,
  normalizeOutpoint,
} from '../wallet/collectables'
import { isItemProven } from '../wallet/provenCache'
import {
  clearNavChild,
  openAddFriend,
  openCollectableDetails,
  openFriendDetails,
  openFungibleDetails,
  openSendFlow,
  setNavSection,
} from '../wallet/navStore'
import {
  clearSpendAttempt,
  isSpendAttempt,
  reclaimSpendAttempt,
  releaseSpendAttemptFunds,
  resolveSpendAttemptFate,
  retrySpendAttempt,
  spendAttemptState,
  SPEND_ATTEMPT_PEER_PUBLISHES,
  type SpendAttemptFate,
} from '../wallet/spendAttempt'
import { toastError, toastSuccess } from '../wallet/toast'
import { playWalletSound } from '../wallet/soundService'
import {
  createCancelMarketListingAdvert,
  getMarketListingAuthorization,
} from '../wallet/marketListing'

type Props = {
  entryId: string
  chain: Chain
}

function openExplorer(url: string) {
  if (window.handcash?.openExternal) {
    void window.handcash.openExternal(url)
  } else {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}

/** Open the collectable only when this wallet still holds that origin. */
function itemLinkOutpoint(item: ActivityItem | undefined): string | null {
  if (!item) return null
  if (item.tokenId?.trim()) return null
  const originKey = item.origin
    .trim()
    .toLowerCase()
    .replace(/\.(\d+)$/, '_$1')
  const pointKey = item.outpoint
    ? normalizeOutpoint(item.outpoint)
    : ''
  const held = getCachedCollectables().find((c) => {
    const heldOrigin = c.origin
      .trim()
      .toLowerCase()
      .replace(/\.(\d+)$/, '_$1')
    const heldPoint = normalizeOutpoint(c.outpoint)
    return (
      (pointKey && heldPoint === pointKey) ||
      (originKey && heldOrigin === originKey)
    )
  })
  return held?.outpoint ?? null
}

function tokenLinkId(item: ActivityItem | undefined): string | null {
  const id = item?.tokenId?.trim().toLowerCase()
  return id || null
}

function eventStatusLabel(method: string): string {
  if (method === 'connect' || method === 'approve') return 'Approved'
  if (method === 'connect-deny' || method === 'deny') return 'Cancelled'
  if (method === 'disconnect') return 'Removed'
  if (method === 'market-list') return 'Listed'
  if (method === 'market-cancel') return 'Cancelled'
  if (method === 'add-friend') return 'Added'
  if (method === 'forget-collectable') return 'Forgot'
  return 'Done'
}

function activityRecordForEntry(
  entry: ActivityEntry,
  recent: readonly ActivityEntry[],
) {
  return (
    composeActivityRecords(recent).find((row) =>
      row.entries.some(
        (leg) => activityEntryKey(leg) === activityEntryKey(entry),
      ),
    ) ?? null
  )
}

function expandedActivityLegs(
  entry: ActivityEntry,
  recent: readonly ActivityEntry[],
): ActivityEntry[] {
  const record = activityRecordForEntry(entry, recent)
  if (!record) return [entry]
  const rows: ActivityEntry[] = []
  const seen = new Set<string>()
  for (const leg of [record.subject, ...record.assets]) {
    const key = activityEntryKey(leg)
    if (seen.has(key)) continue
    seen.add(key)
    rows.push(leg)
  }
  if (record.money) {
    const key = activityEntryKey(record.money)
    if (!seen.has(key)) rows.push(record.money)
  }
  return rows
}

function IdentityMark({
  label,
  onClick,
}: {
  label: string
  onClick?: () => void
}) {
  if (!onClick) {
    return <span className="payment-tx-id">{label}</span>
  }
  return (
    <button
      type="button"
      className="payment-tx-id is-link"
      onClick={() => {
        playWalletSound('soft')
        onClick()
      }}
    >
      {label}
    </button>
  )
}

function PaymentBreakdownRow({
  entry,
  currency,
  usdPerBsv,
}: {
  entry: ActivityEntry
  currency: DisplayCurrency
  usdPerBsv: number | null
}) {
  const shown = entry.item ? viewActivityItem(entry.item) : undefined
  const named = shown ? { ...entry, item: shown } : entry
  const mark = activityActionMark(entry)
  const itemName = shown?.name?.trim()
  const title = itemName || activityEntryTitle(named)
  const contact = activityContactLink(entry)
  const peer = contact?.label ?? activityRecipientLabel(entry)
  const token = isTokenActivity(entry)
  const item = isItemActivity(entry)
  const amount =
    token || (!item && entry.sats > 0)
      ? token
        ? activityTokenAmountDisplay(named)
        : `${entry.kind === 'spent' ? '−' : '+'}${formatPrimaryFromSats(entry.sats, currency, usdPerBsv)}`
      : null
  const itemOutpoint = itemLinkOutpoint(shown)
  const tokenId = tokenLinkId(shown ?? entry.item)
  const openItem = tokenId
    ? () => {
        playWalletSound('soft')
        openFungibleDetails(tokenId)
      }
    : itemOutpoint
      ? () => {
          playWalletSound('soft')
          openCollectableDetails(itemOutpoint)
        }
      : null
  const openPeer = contact?.friendId
    ? () => openFriendDetails(contact.friendId!)
    : contact
      ? () =>
          openAddFriend({
            identityKey: contact.identityKey,
            label: contact.label,
          })
      : undefined

  return (
    <li data-aeon-part="tx-leg" data-aeon-state={mark ?? 'event'}>
      <HistoryIconCluster entry={entry} stacked={false} />
      <div className="payment-tx-leg-copy">
        {openItem ? (
          <button
            type="button"
            className="payment-tx-leg-title is-link"
            onClick={openItem}
          >
            {title}
          </button>
        ) : (
          <strong className="payment-tx-leg-title">{title}</strong>
        )}
        {peer ? (
          <span className="payment-tx-leg-meta">
            {entry.kind === 'spent' ? (
              <>
                <IdentityMark
                  label="You"
                  onClick={() => setNavSection('identity')}
                />
                <span aria-hidden>→</span>
                <IdentityMark label={peer} onClick={openPeer} />
              </>
            ) : entry.kind === 'earned' ? (
              <>
                <IdentityMark label={peer} onClick={openPeer} />
                <span aria-hidden>→</span>
                <IdentityMark
                  label="You"
                  onClick={() => setNavSection('identity')}
                />
              </>
            ) : null}
          </span>
        ) : null}
      </div>
      {amount ? (
        <span className="history-amount">{amount}</span>
      ) : null}
    </li>
  )
}

export function PaymentDetailsPanel({ entryId, chain }: Props) {
  const [entry, setEntry] = useState<ActivityEntry | null>(() =>
    getActivityById(entryId),
  )
  const [usdPerBsv, setUsdPerBsv] = useState<number | null>(() =>
    getCachedUsdPerBsv(),
  )
  const [currency, setCurrency] = useState<DisplayCurrency>(() =>
    getDisplayCurrency(),
  )
  const [attemptFate, setAttemptFate] = useState<SpendAttemptFate>({
    kind: 'notAttempt',
  })
  // One exclusive mutation at a time — retry / clear / release / reclaim — with
  // its failure reason; the chart replaces four booleans OR-ed into `disabled`.
  const action = useActivityAction()
  const { reset: resetAction } = action

  useEffect(() => subscribeUsdRate(setUsdPerBsv), [])
  useEffect(() => subscribeDisplayCurrency(setCurrency), [])
  useEffect(() => {
    // Keep the previous object when nothing the screen reads changed: the fate
    // effect below keys on this row, and resolving a fate can itself write to
    // Activity — a fresh identity per notification made those chase each other.
    const refresh = () =>
      setEntry((prev) => {
        const next = getActivityById(entryId)
        return sameActivityRow(prev, next) ? prev : next
      })
    refresh()
    return subscribeAppActivity(refresh)
  }, [entryId])
  useEffect(() => {
    let cancelled = false
    // A stale failure belongs to the previous row; the chart ignores this while
    // a mutation is still running.
    resetAction()
    if (!isSpendAttempt(entry)) {
      setAttemptFate({ kind: 'notAttempt' })
      return () => {
        cancelled = true
      }
    }
    setAttemptFate({ kind: 'checking' })
    void resolveSpendAttemptFate(entry!, chain).then((fate) => {
      if (!cancelled) setAttemptFate(fate)
    })
    return () => {
      cancelled = true
    }
  }, [entry, chain, resetAction])

  if (!entry) {
    return <p className="connected-empty-line">Transaction not found</p>
  }

  if (entry.method === 'market-list' || entry.method === 'market-cancel') {
    return (
      <ListingActivityDetails entry={entry} chain={chain} />
    )
  }

  if (isEventActivity(entry)) {
    const isWallet = entry.origin === WALLET_ACTIVITY_ORIGIN
    return (
      <div
        className="nav-child-panel payment-details"
        data-aeon-scope="payment-details"
        data-aeon-state="event"
      >
        <div className="payment-details-hero">
          <div className="history-icon-wrap">
            <div className="history-icon">
              {isWallet ? (
                <ReceiveIcon size={16} />
              ) : (
                <AppAvatar
                  origin={entry.origin}
                  name={appDisplayName(entry.origin)}
                  size="sm"
                />
              )}
            </div>
          </div>
          <div className="payment-details-copy">
            <div className="payment-details-title-row">
              <strong className="payment-details-title">
                {activityEntryTitle(entry)}
              </strong>
            </div>
            <p className="history-when">
              {new Date(entry.at).toLocaleString(undefined, {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </p>
          </div>
        </div>
        <div className="app-details-section">
          <dl className="wallet-details">
            <div className="wallet-detail">
              <span>Status</span>
              <span className="wallet-detail-value">
                {eventStatusLabel(entry.method)}
              </span>
            </div>
            {!isWallet ? (
              <div className="wallet-detail">
                <span>App</span>
                <span className="wallet-detail-value">
                  {appDisplayName(entry.origin)}
                </span>
              </div>
            ) : null}
          </dl>
        </div>
      </div>
    )
  }

  const spent = entry.kind === 'spent'
  const item = isItemActivity(entry)
  const token = isTokenActivity(entry)
  const minted =
    isMintTokenActivity(entry) || isMintCollectableActivity(entry)
  const pending = isPendingActivity(entry)
  const failed = isFailedActivity(entry)
  const failureReason = failed ? activityFailureLabel(entry) : null
  const inventoryProven = Boolean(
    entry.item?.outpoint && isItemProven(entry.item.outpoint),
  )
  const showPending = pending && (spent || !inventoryProven)
  const rec = entry.txid ? getTxByTxid(entry.txid) : null
  const pendingLabel =
    inFlightSettlementLabel({
      status: entry.status,
      txid: entry.txid,
      chainProof: rec?.chainProof,
      minedHeight: rec?.minedHeight,
    }) ?? (spent ? 'Signed' : 'Signed')
  // Identity as the wallet knows it now, not as the row froze it on arrival.
  const shownItem = entry.item ? viewActivityItem(entry.item) : undefined
  const detailLabel = activityDetailLabel(entry)
  const isWallet = entry.origin === WALLET_ACTIVITY_ORIGIN
  const recipientLabel =
    isWallet && !item && !token ? activityRecipientLabel(entry) : null
  const itemOutpoint = itemLinkOutpoint(shownItem)
  const tokenId = tokenLinkId(shownItem ?? entry.item)
  const openItem = tokenId
    ? () => {
        playWalletSound('soft')
        openFungibleDetails(tokenId)
      }
    : itemOutpoint
    ? () => {
        playWalletSound('soft')
        openCollectableDetails(itemOutpoint)
      }
    : null
  const viewed = shownItem ? { ...entry, item: shownItem } : entry
  const primary = token
    ? activityTokenAmountDisplay(viewed)
    : item
    ? shownItem?.name || 'Collectable'
    : formatPrimaryFromSats(entry.sats, currency, usdPerBsv)
  const secondary = item
    ? token
      ? minted
        ? shownItem?.name
          ? `Minted · ${shownItem.name}`
          : 'Minted BSV-21'
        : spent
        ? shownItem?.name
          ? `Sent · ${shownItem.name}`
          : 'Sent BSV-21'
        : shownItem?.app || shownItem?.name || 'BSV-21 token'
      : minted
      ? shownItem?.name
        ? `Minted · ${shownItem.name}`
        : 'Minted collectable'
      : shownItem?.app || '1Sat collectable'
    : formatSecondaryFromSats(entry.sats, currency, usdPerBsv)
  // The feed folds a purchase or sale into one record; the detail view opens one
  // of its entries, so it reads the money leg back from the same transaction.
  const recent = listRecentActivity(200)
  const record = activityRecordForEntry(entry, recent)
  const subject = record?.subject ?? entry
  const assets = record?.assets ?? []
  const viewedMembers = [subject, ...assets].map((row) =>
    row.item ? { ...row, item: viewActivityItem(row.item) } : row,
  )
  const batch = activityBatchOf(viewedMembers) ?? record?.batch ?? null
  const batchName = batch ? activityBatchName(batch) : null
  const moneyLeg = moneyLegForEntry(entry, recent)
  const breakdown = expandedActivityLegs(entry, recent)
  const showBreakdown = breakdown.length > 1
  const explorer = isExplorerTxid(entry.txid)
    ? txExplorerUrl(entry.txid!, chain)
    : null

  const retryAttempt = async () => {
    if (!entry || attemptFate.kind !== 'retry') return
    const outcome = await action.run('retry', async () => {
      const result = await retrySpendAttempt(entry, chain)
      // A pre-tx failure creates a fresh row; a signed attempt keeps this row
      // and rebroadcasts its original BEEF. Activity reflects either outcome.
      clearNavChild()
      if (result.kind === 'reopenPayment') openSendFlow(result.toAddress)
    })
    if (outcome.ok || outcome.error === null) return
    toastError('Retry failed', outcome.error)
    playWalletSound('error')
    // The failed retry may have changed spendability; classify again.
    setAttemptFate({ kind: 'checking' })
    setAttemptFate(await resolveSpendAttemptFate(entry, chain))
  }

  const releaseFunds = async () => {
    const outcome = await action.run('release', async () => {
      await releaseSpendAttemptFunds()
      toastSuccess(
        'Coins unlocked',
        'Coins held by sends that were never signed are spendable again.',
      )
    })
    if (!outcome.ok && outcome.error !== null) {
      toastError('Could not free funds', outcome.error)
    }
  }

  const reclaimAttempt = async () => {
    if (!entry) return
    const outcome = await action.run(
      'reclaim',
      async () => {
        const { inputs } = await reclaimSpendAttempt(entry, chain)
        toastSuccess(
          'Coins taken back',
          inputs > 0
            ? `${inputs} input${inputs === 1 ? '' : 's'} are spendable again. The transfer is cancelled.`
            : 'The transfer is cancelled and its coins are spendable again.',
        )
        setAttemptFate({ kind: 'checking' })
        setAttemptFate(await resolveSpendAttemptFate(entry, chain))
      },
      {
        confirm: {
          title: 'Take these coins back?',
          body:
            'Nothing was published, so the coins are yours to spend again. If the recipient publishes their copy later it will be rejected as a double spend — the transfer is cancelled by doing this.',
          confirmLabel: 'Take the coins back',
          danger: true,
        },
      },
    )
    if (!outcome.ok && outcome.error !== null) {
      toastError('Could not take the coins back', outcome.error)
    }
  }

  const clearAttempt = async () => {
    if (!entry) return
    const outcome = await action.run(
      'clear',
      async () => {
        const { removed } = await clearSpendAttempt(entry)
        if (removed) clearNavChild()
      },
      {
        confirm: entry.txid
          ? {
              title: 'Remove this send from Activity?',
              body: 'Its coins are already spent on chain, so this only deletes the history row — it does not undo the payment.',
              confirmLabel: 'Remove from Activity',
              danger: true,
            }
          : {
              title: 'Clear this failed send from Activity?',
              body: 'It never produced a signed transaction, so this only drops the row and releases local reservations.',
              confirmLabel: 'Clear from Activity',
              danger: true,
            },
      },
    )
    if (!outcome.ok && outcome.error !== null) {
      toastError('Clear failed', outcome.error)
    }
  }

  return (
    <div
      className="nav-child-panel payment-details"
      data-aeon-scope="payment-details"
    >
      <div className="payment-details-hero">
        <HistoryIconCluster
          entry={subject}
          assets={assets}
          batch={batch}
        />
        <div className="payment-details-copy">
          <div className="payment-details-title-row">
            <strong className="payment-details-title">
              {activityEntryTitle(
                batchName && subject.item
                  ? {
                      ...subject,
                      item: {
                        ...viewActivityItem(subject.item),
                        name: batchName,
                      },
                    }
                  : subject.item
                    ? { ...subject, item: viewActivityItem(subject.item) }
                    : subject,
              )}
            </strong>
            {explorer ? (
              <button
                type="button"
                className="payment-details-woc"
                onClick={() => openExplorer(explorer)}
              >
                Open in WhatsOnChain
              </button>
            ) : null}
          </div>
          <p className="history-when">
            {showPending
              ? pendingLabel
              : failed && failureReason
                ? failureReason
                : new Date(entry.at).toLocaleString(undefined, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
          </p>
        </div>
      </div>

      <div className="payment-details-amount">
        <strong>
          {batchName
            ? batchName
            : token || item
              ? primary
              : spent
                ? `−${primary}`
                : `+${primary}`}
        </strong>
        <span className="payment-details-secondary">{secondary}</span>
      </div>

      {showBreakdown ? (
        <ol className="payment-tx-breakdown" data-aeon-part="tx-legs">
          {breakdown.map((leg) => (
            <PaymentBreakdownRow
              key={activityEntryKey(leg)}
              entry={leg}
              currency={currency}
              usdPerBsv={usdPerBsv}
            />
          ))}
        </ol>
      ) : null}

      {item && shownItem?.imageUrl && !showBreakdown ? (
        openItem ? (
          <button
            type="button"
            className="payment-details-item-media collectable-media collectable-media-md payment-details-item-link"
            onClick={openItem}
            aria-label={`Open ${shownItem.name}`}
          >
            <DeferredImage
              src={shownItem.imageUrl}
              alt={shownItem.name}
              skeletonRadius={8}
              skeletonClassName="skeleton-qr"
              decoding="async"
            />
          </button>
        ) : (
          <div className="payment-details-item-media collectable-media collectable-media-md">
            <DeferredImage
              src={shownItem.imageUrl}
              alt={shownItem.name}
              skeletonRadius={8}
              skeletonClassName="skeleton-qr"
              decoding="async"
            />
          </div>
        )
      ) : null}

      <dl className="payment-details-meta">
        <dt>Type</dt>
        <dd>{detailLabel}</dd>
        {moneyLeg ? (
          <>
            <dt>{moneyLeg.kind === 'spent' ? 'Paid' : 'Proceeds'}</dt>
            <dd>{formatPrimaryFromSats(moneyLeg.sats, currency, usdPerBsv)}</dd>
          </>
        ) : null}
        {!isWallet && (
          <>
            <dt>App</dt>
            <dd>{appDisplayName(entry.origin)}</dd>
          </>
        )}
        {shownItem ? (
          <>
            <dt>Item</dt>
            <dd>
              {openItem ? (
                <button
                  type="button"
                  className="payment-details-item-name"
                  onClick={openItem}
                >
                  {shownItem.name}
                </button>
              ) : (
                shownItem.name
              )}
            </dd>
            {assets.length > 0 && !showBreakdown ? (
              <>
                <dt>{spent ? 'Also sent' : 'Also received'}</dt>
                <dd>
                  {assets
                    .map(
                      (sibling) =>
                        viewActivityItem(sibling.item!).name?.trim() ||
                        'Collectable',
                    )
                    .join(', ')}
                </dd>
              </>
            ) : null}
            <dt>Origin</dt>
            <dd className="mono">{shownItem.origin}</dd>
            {shownItem.outpoint ? (
              <>
                <dt>Outpoint</dt>
                <dd className="mono">{shownItem.outpoint}</dd>
              </>
            ) : null}
          </>
        ) : null}
        <dt>Method</dt>
        <dd className="mono">{entry.method}</dd>
        {recipientLabel ? (
          <>
            <dt>Recipient</dt>
            <dd>{recipientLabel}</dd>
          </>
        ) : null}
        {entry.note &&
        !(
          recipientLabel &&
          (entry.note.startsWith('Sent to ') || entry.note.startsWith('Sending to '))
        ) ? (
          <>
            <dt>Note</dt>
            <dd>{entry.note}</dd>
          </>
        ) : null}
        {entry.burn ? (
          <>
            <dt>Destroyed</dt>
            <dd>
              {entry.burn.asset === '1sat' && batch
                ? batch.count
                : entry.burn.destroyedAmount}{' '}
              {entry.burn.asset === 'bsv21' ? shownItem?.name ?? 'token units' : 'items'}
            </dd>
            {entry.burn.recoveredSatoshis != null ? (
              <>
                <dt>Recovered to Pay</dt>
                <dd>{entry.burn.recoveredSatoshis.toLocaleString()} sats</dd>
              </>
            ) : null}
            {entry.burn.feeSatoshis != null ? (
              <>
                <dt>Network fee</dt>
                <dd>{entry.burn.feeSatoshis.toLocaleString()} sats</dd>
              </>
            ) : null}
          </>
        ) : null}
        {entry.txid ? (
          <>
            <dt>Txid</dt>
            <dd className="mono">{entry.txid}</dd>
          </>
        ) : null}
      </dl>

      {attemptFate.kind !== 'notAttempt' &&
      attemptFate.kind !== 'confirmed' ? (
        <section
          className="payment-attempt-actions"
          aria-live="polite"
          data-aeon-part="spend-attempt"
          data-aeon-state={spendAttemptState(attemptFate)}
        >
          <strong>
            {spendAttemptState(attemptFate) === SPEND_ATTEMPT_PEER_PUBLISHES
              ? 'Sent — the recipient publishes it'
              : isFailedActivity(entry)
              ? 'Failed send'
              : 'Unconfirmed send'}
          </strong>
          <p>
            {attemptFate.kind === 'checking'
              ? 'Checking confirmation and whether the funds are still spendable…'
              : attemptFate.message}
          </p>
          {action.error ? (
            <p className="form-error">{action.error}</p>
          ) : null}
          <div
            className="payment-attempt-buttons"
            data-aeon-part="spend-attempt-actions"
            data-aeon-state={action.stateAttr}
          >
            {attemptFate.kind === 'retry' ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={action.busy}
                onClick={() => void retryAttempt()}
              >
                {action.running('retry')
                  ? attemptFate.action === 'rebroadcast'
                    ? 'Resubmitting…'
                    : 'Retrying…'
                  : attemptFate.action === 'reopenPayment'
                  ? 'Send again'
                  : attemptFate.action === 'rebroadcast'
                  ? 'Resubmit'
                  : 'Retry send'}
              </button>
            ) : null}
            {((attemptFate.kind === 'retry' && attemptFate.mayClear) ||
              (attemptFate.kind === 'refuse' && attemptFate.mayClear)) && (
              <button
                type="button"
                className="btn btn-danger"
                disabled={action.busy}
                onClick={() => void clearAttempt()}
              >
                {action.running('clear') ? 'Clearing…' : 'Clear from Activity'}
              </button>
            )}
            {(attemptFate.kind === 'refuse' ||
              attemptFate.kind === 'retry') &&
            attemptFate.mayReclaimInputs ? (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={action.busy}
                onClick={() => void reclaimAttempt()}
                title="Spend these coins again. Only possible while the transaction is absent from the chain, and it cancels the transfer."
              >
                {action.running('reclaim') ? 'Taking back…' : 'Take the coins back'}
              </button>
            ) : null}
            {attemptFate.kind === 'refuse' &&
            !attemptFate.mayClear &&
            attemptFate.mayReleaseFunds ? (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={action.busy}
                onClick={() => void releaseFunds()}
                title="Frees coins held by sends that were never signed. This transfer is not affected."
              >
                {action.running('release')
                  ? 'Unlocking…'
                  : 'Unlock coins from unfinished sends'}
              </button>
            ) : null}
          </div>
        </section>
      ) : null}
      <ActivityActionPrompt action={action} />
    </div>
  )
}


function priceFromNote(note: string | undefined): number | null {
  const match = note?.match(/for\s+([\d,]+)\s+sats/i)
  if (!match) return null
  const n = Number(match[1].replace(/,/g, ''))
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

function listingOutpointFor(entry: ActivityEntry): string | null {
  const fromItem = entry.item?.outpoint?.trim()
  if (fromItem) return fromItem.replace('.', '_')
  const txid = entry.txid?.trim().toLowerCase()
  if (txid && /^[0-9a-f]{64}$/.test(txid)) return `${txid}_0`
  return null
}

function ListingActivityDetails({
  entry,
  chain,
}: {
  entry: ActivityEntry
  chain: Chain
}) {
  const action = useActivityAction()
  const shown = entry.item ? viewActivityItem(entry.item) : undefined
  const outpoint = listingOutpointFor(entry)
  const auth = outpoint ? getMarketListingAuthorization({ outpoint }) : null
  const origin = shown?.origin || auth?.origin
  const held = origin
    ? getCachedCollectables().find(
        (c) =>
          c.origin.trim().toLowerCase().replace(/\.(\d+)$/, '_$1') ===
          origin.trim().toLowerCase().replace(/\.(\d+)$/, '_$1'),
      )
    : undefined
  const name =
    (shown?.name && shown.name !== 'Collectable' ? shown.name : undefined) ||
    held?.name ||
    shown?.name ||
    'Collectable'
  const imageUrl = shown?.imageUrl || held?.imageUrl
  const app = shown?.app || held?.app
  const priceSats = auth?.priceSats ?? priceFromNote(entry.note)
  const listed = entry.method === 'market-list' && auth?.state !== 'cancelled'
  const explorer = isExplorerTxid(entry.txid) ? txExplorerUrl(entry.txid!, chain) : null
  const viewed = { ...entry, item: shown ? { ...shown, name } : { name, origin: origin || '', outpoint: outpoint || undefined, ...(imageUrl ? { imageUrl } : {}) } }
  const title = activityEntryTitle(viewed)

  const cancelListing = async () => {
    if (!outpoint) return
    const outcome = await action.run('cancelListing', async () => {
      await createCancelMarketListingAdvert({ outpoint })
      toastSuccess('Listing cancelled', name)
      playWalletSound('success')
    })
    if (!outcome.ok && outcome.error !== null) {
      toastError('Could not cancel listing', outcome.error)
      playWalletSound('error')
    }
  }

  const clearFailedListing = async () => {
    const outcome = await action.run(
      'clear',
      async () => {
        const { removed } = await clearSpendAttempt(entry)
        if (removed) clearNavChild()
      },
      {
        confirm: {
          title: 'Remove this failed listing from Activity?',
          body: `${name} is still in the wallet; only the broken listing record is dropped.`,
          confirmLabel: 'Clear from Activity',
          danger: true,
        },
      },
    )
    if (!outcome.ok && outcome.error !== null) {
      toastError('Clear failed', outcome.error)
    }
  }

  return (
    <div
      className="nav-child-panel payment-details"
      data-aeon-scope="payment-details"
      data-aeon-state="listing"
    >
      <div className="payment-details-hero">
        <div className="history-icon-wrap">
          <div className="history-icon">
            {imageUrl ? (
              <DeferredImage
                className="history-item-thumb"
                src={imageUrl}
                alt=""
                width={32}
                height={32}
                skeletonWidth={32}
                skeletonHeight={32}
                skeletonRadius={6}
                retainDecoded
                decoding="async"
              />
            ) : (
              <ReceiveIcon size={16} />
            )}
          </div>
          <HistoryActionBadge entry={entry} />
          <HistoryAppBadge entry={entry} />
        </div>
        <div className="payment-details-copy">
          <div className="payment-details-title-row">
            <strong className="payment-details-title">{title}</strong>
            {explorer ? (
              <button
                type="button"
                className="payment-details-woc"
                onClick={() => openExplorer(explorer)}
              >
                Open in WhatsOnChain
              </button>
            ) : null}
          </div>
          <p className="history-when">
            {new Date(entry.at).toLocaleString(undefined, {
              dateStyle: 'medium',
              timeStyle: 'short',
            })}
          </p>
        </div>
      </div>

      {imageUrl ? (
        <div className="payment-details-item-media collectable-media collectable-media-md">
          <DeferredImage
            src={imageUrl}
            alt={name}
            skeletonRadius={8}
            skeletonClassName="skeleton-qr"
            decoding="async"
          />
        </div>
      ) : null}

      <div className="payment-details-amount">
        <strong>{name}</strong>
        <span className="payment-details-secondary">
          {priceSats != null
            ? `Listed for ${priceSats.toLocaleString()} sats`
            : app || 'On-chain market offer'}
        </span>
      </div>

      <dl className="payment-details-meta">
        <dt>Status</dt>
        <dd>
          {entry.status === 'failed'
            ? 'Failed'
            : listed
              ? 'Listed'
              : eventStatusLabel(entry.method)}
        </dd>
        {entry.status === 'failed' && entry.failureReason ? (
          <>
            <dt>Error</dt>
            <dd>{entry.failureReason}</dd>
          </>
        ) : null}
        {priceSats != null ? (
          <>
            <dt>Price</dt>
            <dd>{priceSats.toLocaleString()} sats</dd>
          </>
        ) : null}
        {app ? (
          <>
            <dt>Collection</dt>
            <dd>{app}</dd>
          </>
        ) : null}
        {origin ? (
          <>
            <dt>Origin</dt>
            <dd className="mono">{origin}</dd>
          </>
        ) : null}
        {outpoint ? (
          <>
            <dt>Listing</dt>
            <dd className="mono">{outpoint.replace('_', '.')}</dd>
          </>
        ) : null}
        {entry.txid ? (
          <>
            <dt>Txid</dt>
            <dd className="mono">{entry.txid}</dd>
          </>
        ) : null}
      </dl>

      {listed && outpoint && entry.status !== 'failed' ? (
        <section className="payment-attempt-actions">
          {action.error ? <p className="form-error">{action.error}</p> : null}
          <div
            className="payment-attempt-buttons"
            data-aeon-part="spend-attempt-actions"
            data-aeon-state={action.stateAttr}
          >
            <button
              type="button"
              className="btn btn-danger"
              disabled={action.busy}
              onClick={() => void cancelListing()}
            >
              {action.running('cancelListing') ? 'Cancelling…' : 'Cancel listing'}
            </button>
          </div>
        </section>
      ) : null}
      {isFailedMarketListingActivity(entry) ? (
        <section className="payment-attempt-actions">
          <strong>Listing failed</strong>
          <p>
            The market could not verify this listing (amount or origin mismatch).
            Your token is still in the wallet; dismiss this row to try listing again.
          </p>
          {action.error ? <p className="form-error">{action.error}</p> : null}
          <div
            className="payment-attempt-buttons"
            data-aeon-part="spend-attempt-actions"
            data-aeon-state={action.stateAttr}
          >
            <button
              type="button"
              className="btn btn-danger"
              disabled={action.busy}
              onClick={() => void clearFailedListing()}
            >
              {action.running('clear') ? 'Clearing…' : 'Clear from Activity'}
            </button>
          </div>
        </section>
      ) : null}
      <ActivityActionPrompt action={action} />
    </div>
  )
}
