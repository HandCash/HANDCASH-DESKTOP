import { coinPaymentChain, type ActivityEntry } from './appActivity'
import { COIN_INFO, type CoinChain } from './coins/coinChains'
import { formatUsd } from './fx'

function sharePct(part: number, total: number): string {
  const pct = (part / total) * 100
  if (pct > 0 && pct < 1) return '<1%'
  if (pct < 100 && pct > 99) return '>99%'
  return `${Math.round(pct)}%`
}

/**
 * The total's split by coin value, e.g. "92% BSV + 8% LTC", coins with no
 * value left out; null when BSV is all there is.
 */
export function holdingSplitLabel(parts: ReadonlyArray<{ ticker: string; usd: number }>): string | null {
  const held = parts.filter((p) => p.usd > 0)
  const total = held.reduce((sum, p) => sum + p.usd, 0)
  if (!(total > 0) || held.every((p) => p.ticker === 'BSV')) return null
  if (held.length === 1) return `100% ${held[0]!.ticker}`
  return held.map((p) => `${sharePct(p.usd, total)} ${p.ticker}`).join(' + ')
}

/** USD value of `units` on `chain` at `usdPerCoin`; null when the price is unknown. */
export function coinUsd(chain: CoinChain, units: bigint, usdPerCoin: number | null): number | null {
  if (usdPerCoin == null || !Number.isFinite(usdPerCoin)) return null
  return (Number(units) / 10 ** COIN_INFO[chain].decimals) * usdPerCoin
}

/** A native coin payment row in dollars, signed like a BSV row; null when it is not one or its coin has no price. */
export function coinActivityUsdLabel(entry: ActivityEntry, prices: Partial<Record<CoinChain, number | null>>): string | null {
  const chain = coinPaymentChain(entry)
  const item = entry.item
  if (!chain || item?.dec !== COIN_INFO[chain].decimals || !/^\d+$/.test(item.amt ?? '')) return null
  const usd = coinUsd(chain, BigInt(item.amt!), prices[chain] ?? null)
  return usd == null ? null : `${entry.kind === 'spent' ? '−' : '+'}${formatUsd(usd)}`
}
