import { useEffect, useMemo, useState } from 'react'
import { useMachine } from '@xstate/react'
import { Accordion } from '@aeon-ui/react'
import { stateToAttr } from '@aeon-ui/core'
import { tickerMachine } from '../machines/tickerMachine'
import { useTickerCoin } from '../features/tickerCoin'
import { useHeldCoins } from '../features/heldCoins'
import { coinUsd } from '../wallet/heldValue'
import { COIN_INFO, formatCoin, type CoinChain } from '../wallet/coins/coinChains'
import { formatBsvSignificant } from '../wallet/session'
import { formatUsd, formatUsdFromSats } from '../wallet/fx'
import { TICKER_COINS } from '../wallet/tickerCoin'
import { TickerCoinMark, TickerCoinSelector } from './TickerCoinSelector'
import { bsvLogoClassic, bsvLogoDefault } from '../assets/brand/bsvLogos'
import { Skeleton, SkeletonLine } from './Skeleton'
import {
  BSV_CHART_RANGE_LABEL,
  changePctForRange,
  formatPct,
  formatPriceUsd,
  getCachedBsvMarket,
  nextBsvChartRange,
  refreshBsvMarket,
  sparklineForRange,
  subscribeBsvMarket,
  type BsvChartRange,
  type BsvMarketStats,
  type MarketCoin,
} from '../wallet/bsvMarket'
import {
  getBsvLogoClassic,
  registerBsvLogoTap,
  subscribeBsvLogoClassic,
} from '../wallet/bsvLogoPreference'
import {
  dismissToast,
  getToasts,
  subscribeToasts,
  type ToastItem,
  type ToastTone,
} from '../wallet/toast'

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

  if (!path) return <div className="bsv-spark bsv-spark-empty" aria-hidden />

  return (
    <svg
      className={`bsv-spark ${up ? 'bsv-spark-up' : 'bsv-spark-down'}`}
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

function latestToast(items: ToastItem[]): ToastItem | null {
  if (items.length === 0) return null
  return items[items.length - 1] ?? null
}

/** What the wallet holds of `coin` in words, valued at the ticker's own quote; null when it holds none. */
function heldLabel(coin: MarketCoin, heldBsvSats: number | null, heldCoins: Record<CoinChain, bigint>, priceUsd: number | null): string | null {
  if (coin !== 'bsv') {
    const units = heldCoins[coin]
    if (units === 0n) return null
    const usd = coinUsd(coin, units, priceUsd)
    return `${formatCoin(coin, units)} ${COIN_INFO[coin].ticker}${usd == null ? '' : ` · ${formatUsd(usd)}`}`
  }
  if (!heldBsvSats) return null
  return `${formatBsvSignificant(heldBsvSats, 5)}${priceUsd == null ? '' : ` · ${formatUsdFromSats(heldBsvSats, priceUsd)}`}`
}

export function WhatIsBsvPanel({ heldBsvSats }: { heldBsvSats: number | null }) {
  const coin = useTickerCoin()
  const heldCoins = useHeldCoins()
  const [ticker, sendTicker] = useMachine(tickerMachine)
  const [stats, setStats] = useState<BsvMarketStats | null>(() => getCachedBsvMarket(coin))
  const [chartRange, setChartRange] = useState<BsvChartRange>('24h')
  const [openSections, setOpenSections] = useState<string[]>([])
  const [classicLogo, setClassicLogo] = useState(() => getBsvLogoClassic())
  const [logosReady, setLogosReady] = useState({ normal: false, classic: false })
  const [toast, setToast] = useState<ToastItem | null>(() => latestToast(getToasts()))

  useEffect(() => {
    setStats(getCachedBsvMarket(coin))
    const unsub = subscribeBsvMarket(() => setStats(getCachedBsvMarket(coin)))
    void refreshBsvMarket(true, coin)
    const id = window.setInterval(() => void refreshBsvMarket(false, coin), 5 * 60_000)
    return () => {
      unsub()
      window.clearInterval(id)
    }
  }, [coin])

  useEffect(() => subscribeBsvLogoClassic(setClassicLogo), [])

  useEffect(() => subscribeToasts((items) => setToast(latestToast(items))), [])

  useEffect(() => {
    let cancelled = false
    const mark = (key: 'normal' | 'classic') => {
      if (!cancelled) setLogosReady((prev) => (prev[key] ? prev : { ...prev, [key]: true }))
    }
    const load = (src: string, key: 'normal' | 'classic') => {
      const img = new Image()
      img.onload = () => mark(key)
      img.onerror = () => mark(key)
      img.src = src
      if (img.complete && img.naturalWidth > 0) mark(key)
    }
    load(bsvLogoDefault, 'normal')
    load(bsvLogoClassic, 'classic')
    return () => {
      cancelled = true
    }
  }, [])

  const changePct = changePctForRange(stats, chartRange)
  const sparkValues = sparklineForRange(stats, chartRange)
  const up = (changePct ?? 0) >= 0
  const aboutOpen = openSections.includes('about')
  const marketReady = Boolean(stats)
  const logoFrameReady = logosReady.normal
  const rangeLabel = BSV_CHART_RANGE_LABEL[chartRange]
  const tone: ToastTone | null = toast?.tone ?? null
  const showingToast = Boolean(toast)
  const choosing = ticker.matches('choosing')
  const shown = TICKER_COINS[coin]
  const held = heldLabel(coin, heldBsvSats, heldCoins, stats?.priceUsd ?? null)

  return (
    <aside
      className="panel what-is-bsv"
      data-aeon-scope="what-is-bsv"
      data-aeon-state={showingToast && tone ? `toast-${tone}` : stateToAttr(ticker.value)}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && choosing) sendTicker({ type: 'CLOSE' })
      }}
    >
      {choosing ? (
        <TickerCoinSelector selected={coin} onPick={(next) => sendTicker({ type: 'PICK', coin: next })} />
      ) : (
        <div className="bsv-market-body" aria-hidden={showingToast}>
          <div className="bsv-asset-row">
            <button
              type="button"
              data-aeon-part="coin-trigger"
              onClick={() => sendTicker({ type: 'CHOOSE' })}
              aria-haspopup="listbox"
              aria-label={`${shown.name}. Choose the coin shown here`}
              title="Choose the coin shown here"
              tabIndex={showingToast ? -1 : undefined}
            />
            <span className="bsv-logo-btn" aria-hidden>
              {coin !== 'bsv' ? (
                <TickerCoinMark coin={coin} size={44} />
              ) : !logoFrameReady ? (
                <Skeleton className="bsv-logo-skeleton" width={44} height={44} radius={12} />
              ) : (
                <span className="bsv-logo-stack">
                  <img
                    className={`bsv-logo${classicLogo ? '' : ' is-shown'}`}
                    src={bsvLogoDefault}
                    alt=""
                    width={44}
                    height={44}
                    draggable={false}
                  />
                  {logosReady.classic ? (
                    <img
                      className={`bsv-logo${classicLogo ? ' is-shown' : ''}`}
                      src={bsvLogoClassic}
                      alt=""
                      width={44}
                      height={44}
                      draggable={false}
                    />
                  ) : null}
                </span>
              )}
            </span>
            <div className="bsv-asset-text">
              <span data-aeon-part="coin-name">
                <strong>{shown.name}</strong>
                <span data-aeon-part="caret" aria-hidden>▾</span>
              </span>
              {held ? <span data-aeon-part="held">{held}</span> : null}
            </div>
          </div>

          {marketReady ? (
            <strong className="bsv-price" onClick={coin === 'bsv' ? registerBsvLogoTap : undefined}>
              {formatPriceUsd(stats?.priceUsd ?? null)}
            </strong>
          ) : (
            <Skeleton className="bsv-price-skeleton" width="40%" height={28} radius={8} />
          )}

          <div
            className="bsv-stage"
            data-aeon-part="stage"
            data-aeon-state={stateToAttr(aboutOpen ? 'about' : 'chart')}
          >
            <div className="bsv-stage-panel bsv-stage-chart" aria-hidden={aboutOpen}>
              {marketReady ? (
                <>
                  <button
                    type="button"
                    className={`bsv-change ${up ? 'is-up' : 'is-down'}`}
                    onClick={() => setChartRange((r) => nextBsvChartRange(r))}
                    aria-label={`Price change ${rangeLabel}. Click to cycle 24h, 7D, 1M`}
                    title="Click to cycle 24h → 7D → 1M"
                    tabIndex={showingToast || aboutOpen ? -1 : undefined}
                  >
                    {formatPct(changePct)} · {rangeLabel}
                  </button>
                  <Sparkline values={sparkValues} up={up} />
                </>
              ) : (
                <>
                  <SkeletonLine width="22%" height={11} />
                  <div className="bsv-spark bsv-spark-empty" aria-hidden />
                </>
              )}
            </div>
            <div className="bsv-stage-panel bsv-stage-about" aria-hidden={!aboutOpen}>
              <p className="what-is-bsv-lede">{shown.about}</p>
              <a className="bsv-official" href={shown.url} target="_blank" rel="noreferrer">
                Official resources
              </a>
            </div>
          </div>

          <Accordion.Root
            className="bsv-about"
            defaultValue={[]}
            collapsible
            onValueChange={setOpenSections}
          >
            <Accordion.Item value="about" className={`bsv-about-item${aboutOpen ? ' is-open' : ''}`}>
              <Accordion.ItemTrigger
                value="about"
                className={`bsv-about-trigger${aboutOpen ? ' is-open' : ''}`}
              >
                {shown.aboutTitle}
                <Accordion.ItemIndicator className="bsv-about-indicator">▾</Accordion.ItemIndicator>
              </Accordion.ItemTrigger>
            </Accordion.Item>
          </Accordion.Root>
        </div>
      )}

      {toast ? (
        <button
          type="button"
          className="bsv-toast-cover"
          data-aeon-part="toast-cover"
          data-tone={toast.tone}
          aria-live={toast.tone === 'error' ? 'assertive' : 'polite'}
          aria-atomic="true"
          title="Dismiss"
          onClick={() => dismissToast(toast.id)}
        >
          <strong className="bsv-toast-title">{toast.title}</strong>
          {toast.body ? <span className="bsv-toast-body">{toast.body}</span> : null}
        </button>
      ) : null}
    </aside>
  )
}
