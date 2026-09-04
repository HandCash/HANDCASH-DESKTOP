import { useEffect, useState } from 'react'
import { handcashBrand, type HandCashMarkVariant } from '../assets/brand'
import { APP_VERSION } from '../version'
import { DeferredImage } from './DeferredImage'

type Props = {
  variant?: HandCashMarkVariant | 'auto'
  showWordmark?: boolean
  size?: number
  className?: string
}

const markSrc: Record<HandCashMarkVariant, string> = {
  green: handcashBrand.markGreenPng,
  round: handcashBrand.markRoundPng,
  dark: handcashBrand.markDarkPng,
  light: handcashBrand.markLightPng,
}

function productLine(): string {
  const platform = window.handcash?.platform
  if (platform === 'android' || platform === 'ios') return 'Mobile'
  return 'Desktop'
}

function markForSheet(mode: 'light' | 'dark'): HandCashMarkVariant {
  // Match wordmark ink — no extra brand green in the chrome.
  return mode === 'light' ? 'dark' : 'light'
}

function readSheetMode(): 'light' | 'dark' {
  if (typeof document === 'undefined') return 'dark'
  return document.documentElement.dataset.aeonMode === 'light' ? 'light' : 'dark'
}

export function BrandLogo({
  variant = 'auto',
  showWordmark = true,
  size = 34,
  className = '',
}: Props) {
  const [sheet, setSheet] = useState<'light' | 'dark'>(readSheetMode)
  useEffect(() => {
    const root = document.documentElement
    const sync = () => setSheet(readSheetMode())
    sync()
    const obs = new MutationObserver(sync)
    obs.observe(root, { attributes: true, attributeFilter: ['data-aeon-mode'] })
    return () => obs.disconnect()
  }, [])

  const resolved: HandCashMarkVariant =
    variant === 'auto' ? markForSheet(sheet) : variant

  return (
    <div className={`brand ${className}`.trim()} data-aeon-scope="identity" data-aeon-part="root">
      <DeferredImage
        className="brand-logo-mark"
        src={markSrc[resolved]}
        width={size}
        height={size}
        alt="HandCash"
        draggable={false}
        skeletonWidth={size}
        skeletonHeight={size}
        skeletonRadius={8}
        skeletonClassName="brand-logo-skeleton"
      />
      {showWordmark && (
        <div className="brand-wordmark">
          <div className="brand-name">HandCash</div>
          <div className="brand-sub">
            {productLine()}
            <span className="brand-version">v{APP_VERSION}</span>
            <span className="brand-beta">BETA</span>
          </div>
        </div>
      )}
    </div>
  )
}
