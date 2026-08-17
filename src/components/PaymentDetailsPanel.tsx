import { useEffect, useState } from 'react'
import { AppAvatar } from './AppAvatar'
import { ReceiveIcon, SendIcon } from './icons'
import { SkeletonLine } from './Skeleton'
import { appDisplayName } from '../wallet/appIdentity'
import {
  activityDetailLabel,
  activityEntryTitle,
  activityTokenAmountDisplay,
  getActivityById,
  isEventActivity,
  isFailedActivity,
  activityFailureLabel,
  isItemActivity,
  isMintTokenActivity,
  isPendingActivity,
  isTokenActivity,
  subscribeAppActivity,
  WALLET_ACTIVITY_ORIGIN,
  type ActivityEntry,
  type ActivityItem,
} from '../wallet/appActivity'
import { viewActivityItem } from '../wallet/activityItemView'
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
import {
  clearNavChild,
  openCollectableDetails,
  openFungibleDetails,
  openSendFlow,
} from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import {
  clearSpendAttempt,
  isSpendAttempt,
  releaseSpendAttemptFunds,
  resolveSpendAttemptFate,
  retrySpendAttempt,
  type SpendAttemptFate,
} from '../wallet/spendAttempt'
import { toastError, toastSuccess } from '../wallet/toast'

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

/** Prefer a tip we still hold for this origin; fall back to a received outpoint. */
function itemLinkOutpoint(
  entry: ActivityEntry,
  item: ActivityItem | undefined,
): string | null {
  if (!item) return null
  if (item.tokenId?.trim()) return null
  const originKey = item.origin
    .trim()
    .toLowerCase()
    .replace(/\.(\d+)$/, '_$1')
  const held = getCachedCollectables().find(
    (c) =>
      c.origin
        .trim()
        .toLowerCase()
        .replace(/\.(\d+)$/, '_$1') === originKey,
  )
  if (held) return held.outpoint
  // A receive may not be in the Collect cache yet — the activity outpoint is live.
  if (entry.kind === 'earned' && item.outpoint?.trim()) {
    return normalizeOutpoint(item.outpoint)
  }
  return null
}

function tokenLinkId(item: ActivityItem | undefined): string | null {
  const id = item?.tokenId?.trim().toLowerCase()
  return id || null
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
  const [iconReady, setIconReady] = useState(false)
  const [attemptFate, setAttemptFate] = useState<SpendAttemptFate>({
    kind: 'notAttempt',
  })
  const [retrying, setRetrying] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [releasing, setReleasing] = useState(false)
  const [attemptError, setAttemptError] = useState<string | null>(null)

  useEffect(() => subscribeUsdRate(setUsdPerBsv), [])
  useEffect(() => subscribeDisplayCurrency(setCurrency), [])
  useEffect(() => {
    setIconReady(false)
    const refresh = () => setEntry(getActivityById(entryId))
    refresh()
    return subscribeAppActivity(refresh)
  }, [entryId])
  useEffect(() => {
    let cancelled = false
    setAttemptError(null)
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
  }, [entry, chain])

  if (!entry) {
    return <p className="connected-empty-line">Transaction not found</p>
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
          <div className="history-icon">
            {isWallet ? (
              <ReceiveIcon size={16} />
            ) : (
              <AppAvatar
                origin={entry.origin}
                name={appDisplayName(entry.origin)}
                size="sm"
                onReady={() => setIconReady(true)}
              />
            )}
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
              <span>Type</span>
              <span className="wallet-detail-value">
                {activityDetailLabel(entry)}
              </span>
            </div>
            <div className="wallet-detail">
              <span>Action</span>
              <span className="wallet-detail-value mono">{entry.method}</span>
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
  const minted = isMintTokenActivity(entry)
  const pending = isPendingActivity(entry)
  const failed = isFailedActivity(entry)
  const failureReason = failed ? activityFailureLabel(entry) : null
  const inventoryProven = Boolean(
    entry.item?.outpoint &&
      getCachedCollectables().some(
        (c) =>
          c.proven === true &&
          c.outpoint
            .trim()
            .toLowerCase()
            .replace(/_(\d+)$/, '.$1') ===
            entry
              .item!.outpoint!.trim()
              .toLowerCase()
              .replace(/_(\d+)$/, '.$1'),
      ),
  )
  const showPending = pending && (spent || !inventoryProven)
  const pendingLabel = spent ? 'Sending…' : 'Verifying…'
  // Identity as the wallet knows it now, not as the row froze it on arrival.
  const shownItem = entry.item ? viewActivityItem(entry.item) : undefined
  const detailLabel = activityDetailLabel(entry)
  const itemOutpoint = itemLinkOutpoint(entry, shownItem)
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
      : shownItem?.app || '1Sat collectable'
    : formatSecondaryFromSats(entry.sats, currency, usdPerBsv)
  const explorer = isExplorerTxid(entry.txid)
    ? txExplorerUrl(entry.txid!, chain)
    : null
  const isWallet = entry.origin === WALLET_ACTIVITY_ORIGIN
  const ready = isWallet || item || iconReady

  const retryAttempt = async () => {
    if (!entry || attemptFate.kind !== 'retry' || retrying) return
    setRetrying(true)
    setAttemptError(null)
    try {
      const result = await retrySpendAttempt(entry, chain)
      // A pre-tx failure creates a fresh row; a signed attempt keeps this row
      // and rebroadcasts its original BEEF. Activity reflects either outcome.
      clearNavChild()
      if (result.kind === 'reopenPayment') openSendFlow(result.toAddress)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setAttemptError(message)
      toastError('Retry failed', message)
      playWalletSound('error')
      // The failed retry may have changed spendability; classify again.
      setAttemptFate({ kind: 'checking' })
      const next = await resolveSpendAttemptFate(entry, chain)
      setAttemptFate(next)
    } finally {
      setRetrying(false)
    }
  }

  const releaseFunds = async () => {
    if (releasing) return
    setReleasing(true)
    setAttemptError(null)
    try {
      await releaseSpendAttemptFunds()
      toastSuccess(
        'Freed reserved funds',
        'Coins held by half-built sends are spendable again.',
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setAttemptError(message)
      toastError('Could not free funds', message)
    } finally {
      setReleasing(false)
    }
  }

  const clearAttempt = async () => {
    if (!entry || clearing) return
    const confirmed = window.confirm(
      entry.txid
        ? 'Remove this send from Activity? Its coins are already spent on chain, so this only deletes the history row — it does not undo the payment.'
        : 'Clear this failed send from Activity? It never produced a signed transaction, so this only drops the row and releases local reservations.',
    )
    if (!confirmed) return
    setClearing(true)
    setAttemptError(null)
    try {
      const { removed } = await clearSpendAttempt(entry)
      if (removed) clearNavChild()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setAttemptError(message)
      toastError('Clear failed', message)
    } finally {
      setClearing(false)
    }
  }

  return (
    <div
      className="nav-child-panel payment-details"
      data-aeon-scope="payment-details"
      data-aeon-state={ready ? undefined : 'loading'}
    >
      <div className="payment-details-hero">
        <div className="history-icon">
          {item && shownItem?.imageUrl ? (
            openItem ? (
              <button
                type="button"
                className="payment-details-item-thumb-btn"
                onClick={openItem}
                aria-label={`Open ${shownItem.name}`}
              >
                <DeferredImage
                  className="history-item-thumb"
                  src={shownItem.imageUrl}
                  alt=""
                  width={32}
                  height={32}
                  skeletonWidth={32}
                  skeletonHeight={32}
                  skeletonRadius={6}
                  retainDecoded
                  decoding="async"
                />
              </button>
            ) : (
              <DeferredImage
                className="history-item-thumb"
                src={shownItem.imageUrl}
                alt=""
                width={32}
                height={32}
                skeletonWidth={32}
                skeletonHeight={32}
                skeletonRadius={6}
                retainDecoded
                decoding="async"
              />
            )
          ) : isWallet ? (
            spent ? (
              <SendIcon size={16} />
            ) : (
              <ReceiveIcon size={16} />
            )
          ) : (
            <AppAvatar
              origin={entry.origin}
              name={appDisplayName(entry.origin)}
              size="sm"
              onReady={() => setIconReady(true)}
            />
          )}
        </div>
        {ready ? (
          <div className="payment-details-copy">
            <div className="payment-details-title-row">
              <strong className="payment-details-title">
                {activityEntryTitle(entry)}
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
        ) : (
          <div className="payment-details-copy">
            <SkeletonLine width="55%" height={14} />
            <SkeletonLine width="40%" height={10} />
          </div>
        )}
      </div>

      {!ready ? (
        <div className="app-details-section">
          <SkeletonLine width="35%" height={22} />
          <SkeletonLine width="28%" height={12} />
          <SkeletonLine width="70%" height={12} />
          <SkeletonLine width="60%" height={12} />
        </div>
      ) : (
        <>
          <div className="payment-details-amount">
            <strong>
              {token || item ? primary : spent ? `−${primary}` : `+${primary}`}
            </strong>
            <span className="payment-details-secondary">{secondary}</span>
          </div>

          {item && shownItem?.imageUrl ? (
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
            {entry.note ? (
              <>
                <dt>Note</dt>
                <dd>{entry.note}</dd>
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
            <section className="payment-attempt-actions" aria-live="polite">
              <strong>
                {attemptFate.kind === 'refuse' &&
                attemptFate.reason === 'counterpartyMaySettle'
                  ? 'Waiting on the recipient'
                  : isFailedActivity(entry)
                  ? 'Failed send'
                  : 'Unconfirmed send'}
              </strong>
              <p>
                {attemptFate.kind === 'checking'
                  ? 'Checking confirmation and whether the funds are still spendable…'
                  : attemptFate.message}
              </p>
              {attemptError ? (
                <p className="form-error">{attemptError}</p>
              ) : null}
              <div className="payment-attempt-buttons">
                {attemptFate.kind === 'retry' ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={retrying || clearing}
                    onClick={() => void retryAttempt()}
                  >
                    {retrying
                      ? 'Retrying…'
                      : attemptFate.action === 'reopenPayment'
                      ? 'Send again'
                      : 'Retry send'}
                  </button>
                ) : null}
                {(attemptFate.kind === 'retry' ||
                  (attemptFate.kind === 'refuse' && attemptFate.mayClear)) && (
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={retrying || clearing || releasing}
                    onClick={() => void clearAttempt()}
                  >
                    {clearing ? 'Clearing…' : 'Clear from Activity'}
                  </button>
                )}
                {attemptFate.kind === 'refuse' &&
                !attemptFate.mayClear &&
                attemptFate.mayReleaseFunds ? (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={retrying || clearing || releasing}
                    onClick={() => void releaseFunds()}
                    title="Unlock coins reserved by half-built sends without removing this record"
                  >
                    {releasing ? 'Freeing…' : 'Free up reserved funds'}
                  </button>
                ) : null}
              </div>
            </section>
          ) : null}
        </>
      )}
    </div>
  )
}
