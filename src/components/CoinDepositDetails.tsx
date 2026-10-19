import { CoinDepositProgress } from './CoinDepositProgress'
import { TickerCoinMark } from './TickerCoinSelector'
import { useCoinDepositByTxid } from '../features/coinDeposits'
import { useCoinPriceUsd } from '../features/heldCoins'
import { activityEntryTitle, type ActivityEntry } from '../wallet/appActivity'
import { COIN_INFO, formatCoin, type CoinChain } from '../wallet/coins/coinChains'
import { depositBlock } from '../wallet/coins/depositPhase'
import { formatUsd } from '../wallet/fx'
import { coinUsd } from '../wallet/heldValue'
import { coinTxExplorerUrl } from '../wallet/txExplorer'

function openExternal(url: string) {
  if (window.handcash?.openExternal) void window.handcash.openExternal(url)
  else window.open(url, '_blank', 'noopener,noreferrer')
}

const short = (txid: string) => `${txid.slice(0, 10)}…${txid.slice(-6)}`

/**
 * A native coin received: where it stands on this wallet's own header chain
 * for its coin. Explorer links open the bytes for the reader; they decide
 * nothing here.
 */
export function CoinDepositDetails({ chain, entry }: { chain: CoinChain; entry: ActivityEntry }) {
  const deposit = useCoinDepositByTxid(chain, entry.txid)
  const height = depositBlock(deposit?.phase)
  const usdPerCoin = useCoinPriceUsd(chain)
  const usd = deposit ? coinUsd(chain, BigInt(deposit.litoshi), usdPerCoin) : null
  const { label, ticker } = COIN_INFO[chain]
  return (
    <div className="nav-child-panel payment-details" data-aeon-scope="payment-details" data-aeon-state="coin-deposit" data-chain={chain}>
      <div className="payment-details-hero">
        <div className="history-icon-wrap">
          <div className="history-icon">
            <TickerCoinMark coin={chain} size={20} />
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
          <CoinDepositProgress chain={chain} view={deposit} showAmount={false} />
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
              <span className="wallet-detail-value">
                {formatCoin(chain, BigInt(deposit.litoshi))} {ticker}
                {usd == null ? '' : ` · ${formatUsd(usd)}`}
              </span>
            </div>
          ) : null}
          {deposit ? (
            <div className="wallet-detail">
              <span>{label} transaction</span>
              <button
                type="button"
                className="wallet-detail-value payment-details-woc"
                title={`${deposit.txid}:${deposit.vout}`}
                onClick={() => openExternal(coinTxExplorerUrl(chain, deposit.txid))}
              >
                {short(deposit.txid)}:{deposit.vout}
              </button>
            </div>
          ) : null}
          <div className="wallet-detail">
            <span>Network</span>
            <span className="wallet-detail-value">{label}</span>
          </div>
          {height != null ? (
            <div className="wallet-detail">
              <span>{label} block</span>
              <span className="wallet-detail-value">{height.toLocaleString()}</span>
            </div>
          ) : null}
        </dl>
      </div>
    </div>
  )
}
