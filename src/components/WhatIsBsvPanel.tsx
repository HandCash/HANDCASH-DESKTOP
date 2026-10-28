import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useMachine } from '@xstate/react'
import { Accordion } from '@aeon-ui/react'
import { stateToAttr } from '@aeon-ui/core'
import { tickerMachine } from '../machines/tickerMachine'
import { useTickerCoin } from '../features/tickerCoin'
import { useHeldCoins } from '../features/heldCoins'
import { useCompactShell } from '../wallet/isCompactShell'
import type { CoinChain } from '../wallet/coins/coinChains'
import { setTickerCoin, TICKER_COINS } from '../wallet/tickerCoin'
import { useShownMarketCoins } from '../features/acceptedCoins'
import { useFiatCurrency } from '../hooks/useFiatCurrency'
import { stepOnPointer, stepOnWheel } from './carouselWheel'
import { playWalletSound } from '../wallet/soundService'
import { heldIn, TickerCoinMark, TickerCoinSelector } from './TickerCoinSelector'
import { bsvLogoClassic, bsvLogoDefault } from '../assets/brand/bsvLogos'
import { Skeleton, SkeletonLine } from './Skeleton'
import { ExpandMoreIcon } from './icons'
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

/** Where the browser reports the end of a scroll (snap included), the ticker waits for it instead of a quiet timer. */
const HAS_SCROLLEND = typeof window !== 'undefined' && 'onscrollend' in window

function latestToast(items: ToastItem[]): ToastItem | null {
  if (items.length === 0) return null
  return items[items.length - 1] ?? null
}

type SlideShared = {
  heldBsvSats: number | null
  heldCoins: Record<CoinChain, bigint>
  chartRange: BsvChartRange
  onCycleRange: () => void
  classicLogo: boolean
  logosReady: { normal: boolean; classic: boolean }
  onChoose: () => void
}

/** One coin's face in the ticker carousel: mark, held amount, price and chart. */
function MarketSlide({
  coin,
  active,
  heldBsvSats,
  heldCoins,
  chartRange,
  onCycleRange,
  classicLogo,
  logosReady,
  onChoose,
  compact,
}: SlideShared & { coin: MarketCoin; active: boolean; compact: boolean }) {
  const [stats, setStats] = useState<BsvMarketStats | null>(() => getCachedBsvMarket(coin))
  const [openSections, setOpenSections] = useState<string[]>([])
  // Re-render when preferred fiat changes so formatPriceUsd / held labels switch marks.
  useFiatCurrency()

  useEffect(() => {
    setStats(getCachedBsvMarket(coin))
    return subscribeBsvMarket(() => setStats(getCachedBsvMarket(coin)))
  }, [coin])

  const changePct = changePctForRange(stats, chartRange)
  const sparkValues = sparklineForRange(stats, chartRange)
  const up = (changePct ?? 0) >= 0
  const aboutOpen = openSections.includes('about')
  const marketReady = Boolean(stats)
  const rangeLabel = BSV_CHART_RANGE_LABEL[chartRange]
  const shown = TICKER_COINS[coin]
  const held = heldIn(coin, heldBsvSats, heldCoins, stats?.priceUsd ?? null)

  return (
    <div
      className="bsv-market-body bsv-slide"
      data-coin={coin}
      aria-roledescription="slide"
      aria-label={shown.name}
      inert={!active}
      /* Compact: the whole bar opens the coin list. Tap (not swipe) bubbles here;
         the range chip and coin-trigger stopPropagation so they keep their jobs. */
      onClick={
        compact
          ? (e) => {
              if ((e.target as Element).closest('.bsv-change, a')) return
              onChoose()
            }
          : undefined
      }
    >
      <div className="bsv-asset-row">
        <button
          type="button"
          data-aeon-part="coin-trigger"
          onPointerDown={(e) => {
            // Keep the carousel flick tracker off this hitbox so CHOOSE always fires.
            e.stopPropagation()
          }}
          onClick={(e) => {
            e.stopPropagation()
            onChoose()
          }}
          aria-haspopup="listbox"
          aria-label={`${shown.name}. Choose the coin shown here`}
          title="Choose the coin shown here"
        />
        <span className="bsv-logo-btn" aria-hidden>
          {coin !== 'bsv' ? (
            <TickerCoinMark coin={coin} size={32} />
          ) : !logosReady.normal ? (
            <Skeleton className="bsv-logo-skeleton" width={32} height={32} radius={8} />
          ) : (
            <span className="bsv-logo-stack">
              <img
                className={`bsv-logo${classicLogo ? '' : ' is-shown'}`}
                src={bsvLogoDefault}
                alt=""
                width={32}
                height={32}
                draggable={false}
              />
              {logosReady.classic ? (
                <img
                  className={`bsv-logo${classicLogo ? ' is-shown' : ''}`}
                  src={bsvLogoClassic}
                  alt=""
                  width={32}
                  height={32}
                  draggable={false}
                />
              ) : null}
            </span>
          )}
        </span>
        <div className="bsv-asset-text">
          <span data-aeon-part="coin-name">
            <strong>{shown.name}</strong>
            <span data-aeon-part="caret" aria-hidden>
              <ExpandMoreIcon size={16} />
            </span>
          </span>
        </div>
        {/* Amount held lives in the open coin selector only — closed row stays name + price. */}
        {held ? <span className="sr-only">You hold {held.amount}</span> : null}
      </div>

      {marketReady ? (
        <strong
          className="bsv-price"
          onClick={!compact && coin === 'bsv' ? registerBsvLogoTap : undefined}
        >
          {formatPriceUsd(stats?.priceUsd ?? null)}
        </strong>
      ) : (
        <Skeleton className="bsv-price-skeleton" width="40%" height={28} radius={8} />
      )}

      <div className="bsv-stage" data-aeon-part="stage" data-aeon-state={stateToAttr(aboutOpen ? 'about' : 'chart')}>
        <div className="bsv-stage-panel bsv-stage-chart" aria-hidden={aboutOpen}>
          {marketReady ? (
            <>
              <button
                type="button"
                className={`bsv-change ${up ? 'is-up' : 'is-down'}`}
                onClick={(e) => {
                  e.stopPropagation()
                  onCycleRange()
                }}
                aria-label={`Price change ${rangeLabel}. Click to cycle 24h, 7D, 1M`}
                title="Click to cycle 24h → 7D → 1M"
                tabIndex={aboutOpen ? -1 : undefined}
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

      <Accordion.Root className="bsv-about" defaultValue={[]} collapsible onValueChange={setOpenSections}>
        <Accordion.Item value="about" className={`bsv-about-item${aboutOpen ? ' is-open' : ''}`}>
          <Accordion.ItemTrigger value="about" className={`bsv-about-trigger${aboutOpen ? ' is-open' : ''}`}>
            {shown.aboutTitle}
            <Accordion.ItemIndicator className="bsv-about-indicator" aria-hidden>
              <ExpandMoreIcon size={18} />
            </Accordion.ItemIndicator>
          </Accordion.ItemTrigger>
        </Accordion.Item>
      </Accordion.Root>
    </div>
  )
}

export function WhatIsBsvPanel({ heldBsvSats }: { heldBsvSats: number | null }) {
  const coin = useTickerCoin()
  const heldCoins = useHeldCoins()
  const order = useShownMarketCoins()
  const compact = useCompactShell()
  const [ticker, sendTicker] = useMachine(tickerMachine)
  const [chartRange, setChartRange] = useState<BsvChartRange>('24h')
  const [classicLogo, setClassicLogo] = useState(() => getBsvLogoClassic())
  const [logosReady, setLogosReady] = useState({ normal: false, classic: false })
  const [toast, setToast] = useState<ToastItem | null>(() => latestToast(getToasts()))
  const trackRef = useRef<HTMLDivElement | null>(null)
  const settleTimer = useRef<number | null>(null)
  const swipedTo = useRef<MarketCoin | null>(null)
  /** Set when a pointer flick moved a slide — the synthetic click must not open the coin list. */
  const flickedRef = useRef(false)

  useEffect(() => {
    void refreshBsvMarket(true, coin)
    const id = window.setInterval(() => void refreshBsvMarket(false, coin), 5 * 60_000)
    return () => window.clearInterval(id)
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

  const tone: ToastTone | null = toast?.tone ?? null
  const showingToast = Boolean(toast)
  const choosing = ticker.matches('choosing')
  const index = Math.max(0, order.indexOf(coin))

  // A coin picked elsewhere (the menu, a dot) brings its slide into view; one
  // reached by swiping is already there.
  useLayoutEffect(() => {
    const track = trackRef.current
    if (!track || choosing) return
    if (swipedTo.current === coin) {
      swipedTo.current = null
      return
    }
    const left = index * track.clientWidth
    if (Math.abs(track.scrollLeft - left) > 1) track.scrollTo({ left, behavior: 'instant' })
  }, [coin, index, choosing])

  useEffect(() => {
    const track = trackRef.current
    if (!track || choosing) return
    const stopWheel = stepOnWheel(track, order.length)
    const stopPointer = stepOnPointer(track, order.length, () => {
      flickedRef.current = true
    })
    return () => {
      stopWheel()
      stopPointer()
    }
  }, [choosing, order.length])

  const settle = () => {
    const track = trackRef.current
    if (!track || track.clientWidth === 0) return
    const at = track.scrollLeft / track.clientWidth
    // Picking a coin re-renders the dashboard and nav; done between slides, that render lands under the snap animation.
    if (Math.abs(at - Math.round(at)) > 0.02) return
    const next = order[Math.round(at)]
    if (next && next !== coin) {
      swipedTo.current = next
      playWalletSound('soft')
      setTickerCoin(next)
    }
  }

  const settleRef = useRef(settle)
  settleRef.current = settle

  useEffect(() => {
    const track = trackRef.current
    if (!track || choosing || !HAS_SCROLLEND) return
    const onEnd = () => settleRef.current()
    track.addEventListener('scrollend', onEnd)
    return () => track.removeEventListener('scrollend', onEnd)
  }, [choosing])

  const go = (next: number) => {
    const track = trackRef.current
    const target = order[(next + order.length) % order.length]
    if (!track || !target) return
    track.scrollTo({ left: order.indexOf(target) * track.clientWidth, behavior: 'smooth' })
  }

  const shared: SlideShared = {
    heldBsvSats,
    heldCoins,
    chartRange,
    onCycleRange: () => setChartRange((r) => nextBsvChartRange(r)),
    classicLogo,
    logosReady,
    onChoose: () => {
      if (flickedRef.current) {
        flickedRef.current = false
        return
      }
      sendTicker({ type: 'CHOOSE' })
    },
  }

  return (
    <aside
      className="panel what-is-bsv"
      data-aeon-scope="what-is-bsv"
      data-aeon-shell={compact ? 'compact' : 'wide'}
      data-aeon-state={showingToast && tone ? `toast-${tone}` : stateToAttr(ticker.value)}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && choosing) sendTicker({ type: 'CLOSE' })
      }}
    >
      {choosing ? (
        <TickerCoinSelector
          selected={coin}
          heldBsvSats={heldBsvSats}
          onPick={(next) => sendTicker({ type: 'PICK', coin: next })}
        />
      ) : (
        <div className="bsv-carousel-frame" aria-hidden={showingToast} inert={showingToast}>
          <div
            ref={trackRef}
            className="bsv-carousel"
            role="region"
            aria-roledescription="carousel"
            aria-label="Coin prices"
            tabIndex={0}
            onScroll={() => {
              if (HAS_SCROLLEND) return
              if (settleTimer.current != null) window.clearTimeout(settleTimer.current)
              settleTimer.current = window.setTimeout(settle, 120)
            }}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return
              if (e.key === 'ArrowRight') go(index + 1)
              else if (e.key === 'ArrowLeft') go(index - 1)
              else return
              e.preventDefault()
            }}
          >
            {order.map((c) => (
              <MarketSlide key={c} coin={c} active={c === coin} compact={compact} {...shared} />
            ))}
          </div>
          {order.length > 1 ? (
            <div className="bsv-carousel-dots" data-aeon-part="dots">
              {order.map((c, i) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Show ${TICKER_COINS[c].name}`}
                  aria-current={c === coin ? 'true' : undefined}
                  onClick={() => go(i)}
                />
              ))}
            </div>
          ) : null}
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
