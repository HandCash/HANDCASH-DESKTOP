import type { MarketCoin } from './bsvMarket'
import { holdingShares } from './heldValue'
import { TICKER_COINS, TICKER_COIN_ORDER } from './tickerCoin'

export type CoinHolding = {
  coin: MarketCoin
  name: string
  /** The held amount with its ticker, e.g. "0.512 BSV". */
  amount: string
  usd: number | null
  /** Share of the total in dollars, 0–1; null until every held coin has a price. */
  share: number | null
  pct: string | null
}

/** The CSS custom property holding `coin`'s accent. */
export const coinAccentVar = (coin: MarketCoin): string => `--coin-${coin}`

/** Most chips per row at full width: 2, 3, 2+2 and 3+2, so no row holds a lone straggler beside a full one. */
export function holdingsColumns(count: number): number {
  if (count <= 1) return 1
  if (count === 4) return 2
  return Math.min(count, 3)
}

/** Chips per row, top to bottom, for `count` coins at `columns` per row. */
export function holdingsRows(count: number, columns = holdingsColumns(count)): number[] {
  const rows: number[] = []
  for (let left = count; left > 0; left -= columns) rows.push(Math.min(columns, left))
  return rows
}

/** The strip under the balance appears once a wallet holds two coins; one coin is the headline alone. */
export const showsHoldings = (holdings: readonly CoinHolding[]): boolean => holdings.length >= 2

/**
 * Each held coin in ticker order with its amount, dollar value and share of
 * the total. Coins held at zero are left out.
 */
export function coinHoldings(
  held: ReadonlyArray<{ coin: MarketCoin; amount: string; usd: number | null; nonZero: boolean }>,
): CoinHolding[] {
  const rank = (coin: MarketCoin) => TICKER_COIN_ORDER.indexOf(coin)
  const parts = held.filter((h) => h.nonZero).sort((a, b) => rank(a.coin) - rank(b.coin))
  const priced = parts.every((p) => p.usd != null)
  const total = priced ? parts.reduce((sum, p) => sum + (p.usd ?? 0), 0) : 0
  const shares = priced
    ? holdingShares(parts.map((p) => ({ coin: p.coin, ticker: TICKER_COINS[p.coin].sym, usd: p.usd ?? 0 })))
    : null
  return parts.map((p) => {
    const share = priced && total > 0 ? (p.usd ?? 0) / total : null
    return {
      coin: p.coin,
      name: TICKER_COINS[p.coin].name,
      amount: p.amount,
      usd: p.usd,
      share,
      pct: shares?.find((s) => s.coin === p.coin)?.pct ?? null,
    }
  })
}
