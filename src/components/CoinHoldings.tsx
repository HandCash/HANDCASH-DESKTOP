import { formatUsd } from '../wallet/fx'
import { holdingsColumns, type CoinHolding } from '../wallet/coinHoldings'
import { TickerCoinMark } from './TickerCoinSelector'

/** Every coin held, under the balance: a share bar in each coin's accent, then one chip per coin. */
export function CoinHoldings({ holdings }: { holdings: readonly CoinHolding[] }) {
  const shared = holdings.every((h) => h.share != null)
  return (
    <div
      className="coin-holdings"
      data-aeon-scope="coin-holdings"
      data-count={holdings.length}
      data-cols={holdingsColumns(holdings.length)}
    >
      {shared ? (
        <div className="coin-holdings-bar" aria-hidden>
          {holdings.map((h) => (
            <span key={h.coin} data-coin={h.coin} style={{ flexGrow: h.share ?? 0 }} />
          ))}
        </div>
      ) : null}
      <ul className="coin-holdings-list" aria-label="Coins held">
        {holdings.map((h) => (
          <li key={h.coin} className="coin-holding" data-coin={h.coin}>
            <span className="coin-holding-body">
              <TickerCoinMark coin={h.coin} size={24} />
              <span className="coin-holding-copy">
                <span className="coin-holding-name">{h.name}</span>
                <span className="coin-holding-amount">{h.amount}</span>
              </span>
              {h.usd != null ? (
                <span className="coin-holding-value">
                  <span className="coin-holding-usd">{formatUsd(h.usd)}</span>
                  {h.pct ? <span className="coin-holding-pct">{h.pct}</span> : null}
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
