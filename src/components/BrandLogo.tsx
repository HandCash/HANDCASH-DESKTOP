import { handcashBrand, type HandCashMarkVariant } from '../assets/brand'
import { APP_VERSION } from '../version'
import { DeferredImage } from './DeferredImage'

type Props = {
  variant?: HandCashMarkVariant
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

function productLabel(): string {
  const platform = window.handcash?.platform
  if (platform === 'android' || platform === 'ios') return 'Mobile'
  if (typeof document !== 'undefined' && document.documentElement.classList.contains('platform-mobile')) {
    return 'Mobile'
  }
  return 'Desktop'
}

export function BrandLogo({
  variant = 'green',
  showWordmark = true,
  size = 34,
  className = '',
}: Props) {
  const edition = productLabel()
  return (
    <div className={`brand ${className}`.trim()} data-aeon-scope="identity" data-aeon-part="root">
      <DeferredImage
        className="brand-logo-mark"
        src={markSrc[variant]}
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
            {edition}
            <span className="brand-version">v{APP_VERSION}</span>
            <span className="brand-beta">BETA</span>
          </div>
        </div>
      )}
    </div>
  )
}
