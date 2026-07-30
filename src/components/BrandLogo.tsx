import { handcashBrand, type HandCashMarkVariant } from '../assets/brand'
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

export function BrandLogo({
  variant = 'green',
  showWordmark = true,
  size = 34,
  className = '',
}: Props) {
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
        <div>
          <div className="brand-name">
            HandCash <span className="brand-beta">BETA</span>
          </div>
          <div className="brand-sub">Desktop</div>
        </div>
      )}
    </div>
  )
}
