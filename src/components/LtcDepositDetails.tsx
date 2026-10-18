import { LitecoinIcon } from './icons'
import { LtcDepositProgress } from './LtcDepositProgress'
import { useLtcDepositByMint } from '../features/ltcDeposits'
import { activityEntryTitle, type ActivityEntry } from '../wallet/appActivity'
import { formatLtc } from '../wallet/wltc/litecoin'
import { isExplorerTxid, txExplorerUrl } from '../wallet/txExplorer'
import type { Chain } from '../wallet/vault'

const LTC_EXPLORER_TX = 'https://litecoinspace.org/tx/'

function openExternal(url: string) {
  if (window.handcash?.openExternal) void window.handcash.openExternal(url)
  else window.open(url, '_blank', 'noopener,noreferrer')
}

const short = (txid: string) => `${txid.slice(0, 10)}…${txid.slice(-6)}`

/**
 * A wLTC credit: where its Litecoin deposit stands on this wallet's own header
 * chain. Explorer links open the bytes for the reader; they decide nothing here.
 */
export function LtcDepositDetails({ entry, chain }: { entry: ActivityEntry; chain: Chain }) {
  const deposit = useLtcDepositByMint(entry.txid)
  const height = deposit
    ? deposit.phase.kind === 'confirming'
      ? deposit.phase.height
      : deposit.phase.kind === 'movable'
        ? deposit.phase.height
        : deposit.phase.kind === 'unchecked'
          ? deposit.phase.last?.height
          : undefined
    : undefined
  return (
    <div className="nav-child-panel payment-details" data-aeon-scope="payment-details" data-aeon-state="ltc-deposit">
      <div className="payment-details-hero">
        <div className="history-icon-wrap">
          <div className="history-icon">
            <LitecoinIcon size={20} />
          </div>
        </div>
        <div className="payment-details-copy">
          <div className="payment-details-title-row">
            <strong className="payment-details-title">{activityEntryTitle(entry)}</strong>
          </div>
          <p className="history-when">
            {new Date(entry.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
          </p>
        </div>
      </div>
      {deposit ? (
        <div className="app-details-section">
          <LtcDepositProgress view={deposit} showAmount={false} />
        </div>
      ) : null}
      <div className="app-details-section">
        <dl className="wallet-details">
          {deposit ? null : (
            <div className="wallet-detail">
              <span>Status</span>
              <span className="wallet-detail-value">Not tracked on this device</span>
            </div>
          )}
          {deposit ? (
            <div className="wallet-detail">
              <span>Amount</span>
              <span className="wallet-detail-value">{formatLtc(BigInt(deposit.litoshi))} wLTC</span>
            </div>
          ) : null}
          {deposit ? (
            <div className="wallet-detail">
              <span>Litecoin deposit</span>
              <button
                type="button"
                className="wallet-detail-value payment-details-woc"
                title={`${deposit.txid}:${deposit.vout}`}
                onClick={() => openExternal(`${LTC_EXPLORER_TX}${deposit.txid}`)}
              >
                {short(deposit.txid)}:{deposit.vout}
              </button>
            </div>
          ) : null}
          {height != null ? (
            <div className="wallet-detail">
              <span>Litecoin block</span>
              <span className="wallet-detail-value">{height.toLocaleString()}</span>
            </div>
          ) : null}
          {isExplorerTxid(entry.txid) ? (
            <div className="wallet-detail">
              <span>BSV mint</span>
              <button
                type="button"
                className="wallet-detail-value payment-details-woc"
                title={entry.txid}
                onClick={() => openExternal(txExplorerUrl(entry.txid!, chain))}
              >
                {short(entry.txid!)}
              </button>
            </div>
          ) : null}
        </dl>
      </div>
    </div>
  )
}
