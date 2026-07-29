import { useEffect, useMemo, useRef, useState } from 'react'
import { Accordion } from '@aeon-ui/react'
import { stateToAttr } from '@aeon-ui/core'
import bsvLogo from '../assets/brand/bsv-logo.png'
import bsvLogoClassic from '../assets/brand/bsv-logo-classic.png'
import { Skeleton, SkeletonLine } from './Skeleton'
import { DeferredImage } from './DeferredImage'
import {
  OFFICIAL_URL,
  formatPct,
  formatPriceUsd,
  getCachedBsvMarket,
  refreshBsvMarket,
  subscribeBsvMarket,
  type BsvMarketStats,
} from '../wallet/bsvMarket'

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

export function WhatIsBsvPanel() {
  const [stats, setStats] = useState<BsvMarketStats | null>(() => getCachedBsvMarket())
  const [openSections, setOpenSections] = useState<string[]>([])
  const [classicLogo, setClassicLogo] = useState(false)
  const [logoReady, setLogoReady] = useState(false)
  const logoTaps = useRef({ count: 0, timer: 0 })

  useEffect(() => {
    setLogoReady(false)
  }, [classicLogo])

  useEffect(() => {
    const unsub = subscribeBsvMarket(() => setStats(getCachedBsvMarket()))
    void refreshBsvMarket()
    const id = window.setInterval(() => void refreshBsvMarket(), 5 * 60_000)
    return () => {
      unsub()
      window.clearInterval(id)
      window.clearTimeout(logoTaps.current.timer)
    }
  }, [])

  const onLogoTap = () => {
    const taps = logoTaps.current
    window.clearTimeout(taps.timer)
    taps.count += 1
    if (taps.count >= 3) {
      taps.count = 0
      setClassicLogo((v) => !v)
      return
    }
    taps.timer = window.setTimeout(() => {
      taps.count = 0
    }, 700)
  }

  const change24 = stats?.change24hPct ?? null
  const up24 = (change24 ?? 0) >= 0
  const aboutOpen = openSections.includes('about')
  const logoSrc = classicLogo ? bsvLogoClassic : bsvLogo
  const marketReady = Boolean(stats)

  return (
    <aside className="panel what-is-bsv" data-aeon-scope="what-is-bsv">
      <div className="bsv-asset-row">
        <button
          type="button"
          className={`bsv-logo-btn${classicLogo ? ' is-classic' : ''}`}
          onClick={onLogoTap}
          aria-label={classicLogo ? 'Bitcoin SV classic logo' : 'Bitcoin SV logo'}
          title="Bitcoin SV"
        >
          <DeferredImage
            className="bsv-logo"
            src={logoSrc}
            alt=""
            width={44}
            height={44}
            draggable={false}
            skeletonWidth={44}
            skeletonHeight={44}
            skeletonRadius={12}
            skeletonClassName="bsv-logo-skeleton"
            onReady={() => setLogoReady(true)}
          />
        </button>
        <div className="bsv-asset-text">
          {logoReady && marketReady ? (
            <>
              <strong>Bitcoin SV (BSV)</strong>
              <span className={`bsv-change ${up24 ? 'is-up' : 'is-down'}`}>
                {formatPct(change24)} · 24h
              </span>
            </>
          ) : (
            <>
              <SkeletonLine width="70%" height={14} />
              <SkeletonLine width="45%" height={11} />
            </>
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
            <Sparkline values={stats?.sparkline ?? []} up={up24} />
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
            What is BSV
            <Accordion.ItemIndicator className="bsv-about-indicator">▾</Accordion.ItemIndicator>
          </Accordion.ItemTrigger>
        </Accordion.Item>
      </Accordion.Root>
    </aside>
  )
}
