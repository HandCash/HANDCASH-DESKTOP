import type { CSSProperties } from 'react'
import { SWAP_ASSET_INFO, unitsToDecimal, type SwapAsset } from '../wallet/swap/assets'
import { TickerCoinMark } from './TickerCoinSelector'
import { FriendsIcon, SwapIcon } from './icons'

/** The paid coin's logo tucked behind the received coin's. */
export function SwapPairMark({ from, to, size = 26 }: { from: SwapAsset; to: SwapAsset; size?: number }) {
  return (
    <span data-aeon-scope="swap-pair" style={{ '--swap-pair-size': `${size}px` } as CSSProperties} aria-hidden="true">
      <span data-aeon-part="coin">
        <TickerCoinMark coin={from} size={size} />
      </span>
      <span data-aeon-part="coin">
        <TickerCoinMark coin={to} size={size} />
      </span>
    </span>
  )
}

type SummaryLegProps = { asset: SwapAsset; units: bigint; caption: string }

/** Both legs of a swap by logo, amount and ticker; what leaves on the left. */
export function SwapSummary({ pay, receive }: { pay: SummaryLegProps; receive: SummaryLegProps }) {
  return (
    <div data-aeon-scope="swap-summary">
      <SummaryLeg {...pay} />
      <span data-aeon-part="arrow" aria-hidden="true">
        <SwapIcon size={16} />
      </span>
      <SummaryLeg {...receive} />
    </div>
  )
}

function SummaryLeg({ asset, units, caption }: SummaryLegProps) {
  return (
    <div data-aeon-part="leg">
      <TickerCoinMark coin={asset} size={36} />
      <span data-aeon-part="caption">{caption}</span>
      <span data-aeon-part="amount">{unitsToDecimal(asset, units)}</span>
      <span data-aeon-part="ticker">{SWAP_ASSET_INFO[asset].ticker}</span>
    </div>
  )
}

/** Wallet to wallet, or through Exolix. */
export function SwapRouteBadge({ kind }: { kind: 'direct' | 'exolix' }) {
  return (
    <span data-aeon-scope="swap-route-badge" data-route={kind} aria-hidden="true">
      {kind === 'direct' ? <FriendsIcon size={18} /> : <SwapIcon size={18} />}
    </span>
  )
}

type SwapTone = 'done' | 'moving' | 'returned' | 'stopped'

/** Exolix statuses and stages, and direct-swap outcomes; anything else is still moving. */
const TONES: Record<string, SwapTone> = {
  success: 'done',
  swapped: 'done',
  refunded: 'returned',
  created: 'stopped',
  'pay-failed': 'stopped',
  overdue: 'stopped',
  declined: 'stopped',
  expired: 'stopped',
  missed: 'stopped',
  refused: 'stopped',
}

const TONE_LABEL: Record<SwapTone, string> = { done: 'Done', moving: 'In progress', returned: 'Refunded', stopped: 'Stopped' }

export function SwapStatusPill({ state }: { state: string }) {
  const tone = TONES[state] ?? 'moving'
  return (
    <span data-aeon-scope="swap-status" data-tone={tone}>
      {TONE_LABEL[tone]}
    </span>
  )
}
