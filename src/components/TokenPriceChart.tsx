import { useMemo } from 'react'
import type { TokenMarketPricePoint } from '../wallet/tokenMarketView'
import {
  formatPrimaryFromSats,
  getCachedUsdPerBsv,
} from '../wallet/fx'
import {
  getDisplayCurrency,
  type DisplayCurrency,
} from '../wallet/displayCurrency'

type Props = {
  points: TokenMarketPricePoint[]
  currency?: DisplayCurrency
  usdPerBsv?: number | null
}

function Sparkline({ values, up }: { values: number[]; up: boolean }) {
  const path = useMemo(() => {
    if (values.length < 2) return null
    const min = Math.min(...values)
    const max = Math.max(...values)
    const span = max - min || 1
    const w = 280
    const h = 72
    const step = w / (values.length - 1)
    const pts = values.map((v, i) => {
      const x = i * step
      const y = h - ((v - min) / span) * (h - 8) - 4
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    return { d: `M ${pts.join(' L ')}`, w, h }
  }, [values])

  if (!path) {
    return <div className="token-market-spark token-market-spark-empty" aria-hidden />
  }

  return (
    <svg
      className={`token-market-spark ${up ? 'token-market-spark-up' : 'token-market-spark-down'}`}
      viewBox={`0 0 ${path.w} ${path.h}`}
      preserveAspectRatio="none"
      aria-hidden
    >
      <path
        d={path.d}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function TokenPriceChart({
  points,
  currency = getDisplayCurrency(),
  usdPerBsv = getCachedUsdPerBsv(),
}: Props) {
  const values = points.map((p) => p.priceSats)
  const latest = values.length ? values[values.length - 1]! : null
  const first = values.length ? values[0]! : null
  const up = latest != null && first != null ? latest >= first : true

  if (values.length < 2) {
    return (
      <div className="token-market-chart" data-aeon-state="empty">
        <p className="token-market-chart-empty">
          List this token on the market to start a local price history.
        </p>
      </div>
    )
  }

  return (
    <div className="token-market-chart" data-aeon-state="ready">
      <div className="token-market-chart-head">
        <strong className="token-market-chart-price">
          {formatPrimaryFromSats(latest ?? 0, currency, usdPerBsv)}
        </strong>
        <span className="token-market-chart-caption">
          Latest list price · {values.length} local listing{values.length === 1 ? '' : 's'}
        </span>
      </div>
      <Sparkline values={values} up={up} />
    </div>
  )
}
