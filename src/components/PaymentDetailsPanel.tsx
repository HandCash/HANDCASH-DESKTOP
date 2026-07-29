import { useEffect, useState } from 'react'
import { AppAvatar } from './AppAvatar'
import { ReceiveIcon, SendIcon } from './icons'
import { SkeletonLine } from './Skeleton'
import { appDisplayName } from '../wallet/appIdentity'
import {
  getActivityById,
  WALLET_ACTIVITY_ORIGIN,
  type ActivityEntry,
} from '../wallet/appActivity'
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

type Props = {
  entryId: string
  chain: Chain
}

function entryTitle(entry: ActivityEntry): string {
  if (entry.origin === WALLET_ACTIVITY_ORIGIN) {
    return entry.kind === 'spent' ? 'Sent' : 'Received'
  }
  const name = appDisplayName(entry.origin)
  if (entry.kind === 'spent') return entry.note?.trim() || `Paid ${name}`
  return entry.note?.trim() || `From ${name}`
}

function openExplorer(url: string) {
  if (window.handcash?.openExternal) {
    void window.handcash.openExternal(url)
  } else {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}

export function PaymentDetailsPanel({ entryId, chain }: Props) {
  const [entry, setEntry] = useState<ActivityEntry | null>(() => getActivityById(entryId))
  const [usdPerBsv, setUsdPerBsv] = useState<number | null>(() => getCachedUsdPerBsv())
  const [currency, setCurrency] = useState<DisplayCurrency>(() => getDisplayCurrency())
  const [iconReady, setIconReady] = useState(false)

  useEffect(() => subscribeUsdRate(setUsdPerBsv), [])
  useEffect(() => subscribeDisplayCurrency(setCurrency), [])
  useEffect(() => {
    setEntry(getActivityById(entryId))
    setIconReady(false)
  }, [entryId])

  if (!entry) {
    return <p className="connected-empty-line">Payment not found</p>
  }

  const spent = entry.kind === 'spent'
  const primary = formatPrimaryFromSats(entry.sats, currency, usdPerBsv)
  const secondary = formatSecondaryFromSats(entry.sats, currency, usdPerBsv)
  const explorer = isExplorerTxid(entry.txid) ? txExplorerUrl(entry.txid!, chain) : null
  const isWallet = entry.origin === WALLET_ACTIVITY_ORIGIN
  const ready = isWallet || iconReady

  return (
    <div
      className="nav-child-panel payment-details"
      data-aeon-scope="payment-details"
      data-aeon-state={ready ? undefined : 'loading'}
    >
      <div className="payment-details-hero">
        <div className="history-icon">
          {isWallet ? (
            spent ? <SendIcon size={16} /> : <ReceiveIcon size={16} />
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
              <strong className="payment-details-title">{entryTitle(entry)}</strong>
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
              {spent ? `−${primary}` : `+${primary}`}
            </strong>
            <span className="payment-details-secondary">{secondary}</span>
          </div>

          <dl className="payment-details-meta">
            {!isWallet && (
              <>
                <dt>App</dt>
                <dd>{appDisplayName(entry.origin)}</dd>
              </>
            )}
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
        </>
      )}
    </div>
  )
}
