import { useEffect, useMemo, useRef, useState } from 'react'
import { Accordion } from '@aeon-ui/react'
import { stateToAttr } from '@aeon-ui/core'
import bsvLogo from '../assets/brand/bsv-logo.png'
import bsvLogoClassic from '../assets/brand/bsv-logo-classic.png'
import { Skeleton, SkeletonLine } from './Skeleton'
import {
  BSV_CHART_RANGE_LABEL,
  OFFICIAL_URL,
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
} from '../wallet/bsvMarket'
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

export function WhatIsBsvPanel() {
  const [stats, setStats] = useState<BsvMarketStats | null>(() => getCachedBsvMarket())
  const [chartRange, setChartRange] = useState<BsvChartRange>('24h')
  const [openSections, setOpenSections] = useState<string[]>([])
  const [classicLogo, setClassicLogo] = useState(false)
  const [logosReady, setLogosReady] = useState({ normal: false, classic: false })
  const [toast, setToast] = useState<ToastItem | null>(() => latestToast(getToasts()))
  const logoTaps = useRef({ count: 0, timer: 0 })
  const logosReadyRef = useRef(logosReady)
  const pendingClassicRef = useRef<boolean | null>(null)
  logosReadyRef.current = logosReady

  useEffect(() => {
    const unsub = subscribeBsvMarket(() => setStats(getCachedBsvMarket()))
    void refreshBsvMarket(true)
    const id = window.setInterval(() => void refreshBsvMarket(), 5 * 60_000)
    return () => {
      unsub()
      window.clearInterval(id)
      window.clearTimeout(logoTaps.current.timer)
    }
  }, [])

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
    load(bsvLogo, 'normal')
    load(bsvLogoClassic, 'classic')
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (pendingClassicRef.current == null) return
    const wantClassic = pendingClassicRef.current
    const ready = wantClassic ? logosReady.classic : logosReady.normal
    if (!ready) return
    pendingClassicRef.current = null
    setClassicLogo(wantClassic)
  }, [logosReady])

  const onLogoTap = () => {
    const taps = logoTaps.current
    window.clearTimeout(taps.timer)
    taps.count += 1
    if (taps.count >= 3) {
      taps.count = 0
      const next = !classicLogo
      const ready = next ? logosReadyRef.current.classic : logosReadyRef.current.normal
      if (!ready) {
        pendingClassicRef.current = next
        return
      }
      setClassicLogo(next)
      return
    }
    taps.timer = window.setTimeout(() => {
      taps.count = 0
    }, 700)
  }

  const changePct = changePctForRange(stats, chartRange)
  const sparkValues = sparklineForRange(stats, chartRange)
  const up = (changePct ?? 0) >= 0
  const aboutOpen = openSections.includes('about')
  const marketReady = Boolean(stats)
  const logoFrameReady = logosReady.normal
  const rangeLabel = BSV_CHART_RANGE_LABEL[chartRange]
  const tone: ToastTone | null = toast?.tone ?? null
  const showingToast = Boolean(toast)

  return (
    <aside
      className="panel what-is-bsv"
      data-aeon-scope="what-is-bsv"
      data-aeon-state={showingToast && tone ? `toast-${tone}` : 'market'}
    >
      <div className="bsv-market-body" aria-hidden={showingToast}>
        <div className="bsv-asset-row">
          <button
            type="button"
            className={`bsv-logo-btn${classicLogo ? ' is-classic' : ''}`}
            onClick={onLogoTap}
            aria-label={classicLogo ? 'Bitcoin SV classic logo' : 'Bitcoin SV logo'}
            title="Bitcoin SV"
            tabIndex={showingToast ? -1 : undefined}
          >
            {!logoFrameReady ? (
              <Skeleton className="bsv-logo-skeleton" width={44} height={44} radius={12} />
            ) : (
              <span className="bsv-logo-stack" aria-hidden>
                <img
                  className={`bsv-logo${classicLogo ? '' : ' is-active'}`}
                  src={bsvLogo}
                  alt=""
                  width={44}
                  height={44}
                  draggable={false}
                />
                {logosReady.classic ? (
                  <img
                    className={`bsv-logo${classicLogo ? ' is-active' : ''}`}
                    src={bsvLogoClassic}
                    alt=""
                    width={44}
                    height={44}
                    draggable={false}
                  />
                ) : null}
              </span>
            )}
          </button>
          <div className="bsv-asset-text">
            <strong>Bitcoin SV (BSV)</strong>
            {marketReady ? (
              <button
                type="button"
                className={`bsv-change ${up ? 'is-up' : 'is-down'}`}
                onClick={() => setChartRange((r) => nextBsvChartRange(r))}
                aria-label={`Price change ${rangeLabel}. Click to cycle 24h, 7D, 1M`}
                title="Click to cycle 24h → 7D → 1M"
                tabIndex={showingToast ? -1 : undefined}
              >
                {formatPct(changePct)} · {rangeLabel}
              </button>
            ) : (
              <SkeletonLine width="45%" height={11} />
            )}
          </div>
        </div>

        {marketReady ? (
          <strong className="bsv-price">{formatPriceUsd(stats?.priceUsd ?? null)}</strong>
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
              <Sparkline values={sparkValues} up={up} />
            ) : (
              <div className="bsv-spark bsv-spark-empty" aria-hidden />
            )}
          </div>
          <div className="bsv-stage-panel bsv-stage-about" aria-hidden={!aboutOpen}>
            <p className="what-is-bsv-lede">
              Bitcoin (BSV) is an electronic cash system that enables direct, online payments from one
              party to another. It functions exactly like physical cash but for the web.
            </p>
            <a className="bsv-official" href={OFFICIAL_URL} target="_blank" rel="noreferrer">
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
              What is BSV?
              <Accordion.ItemIndicator className="bsv-about-indicator">▾</Accordion.ItemIndicator>
            </Accordion.ItemTrigger>
          </Accordion.Item>
        </Accordion.Root>
      </div>

      {toast ? (
        <button
          type="button"
          className="bsv-toast-cover aeon-surface"
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
