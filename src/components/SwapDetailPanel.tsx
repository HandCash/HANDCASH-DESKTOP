import { Button } from '@aeon-ui/react'
import { useSwapViews } from '../features/swap'
import { openSwapFlow } from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import { SWAP_ASSET_INFO, type SwapAsset } from '../wallet/swap/assets'
import { SWAP_LEG_LABEL, SWAP_ROUTE_LABEL, type SwapLeg } from '../wallet/swap/swapView'
import { coinTxExplorerUrl, txExplorerUrl } from '../wallet/txExplorer'
import type { Chain } from '../wallet/vault'
import { EmptyState } from './EmptyState'
import { SwapIcon } from './icons'
import { SwapPairMark, SwapRouteBadge, SwapStatusPill, SwapSummary } from './SwapVisuals'

const EXOLIX_EXCHANGE_URL = 'https://exolix.com/transaction/'

function openExternal(url: string) {
  if (window.handcash?.openExternal) void window.handcash.openExternal(url)
  else window.open(url, '_blank', 'noopener,noreferrer')
}

const short = (txid: string) => `${txid.slice(0, 10)}…${txid.slice(-6)}`

function legUrl(leg: SwapLeg, chain: Chain): string {
  return leg.asset === 'bsv' ? txExplorerUrl(leg.txid, chain) : coinTxExplorerUrl(leg.asset as Exclude<SwapAsset, 'bsv'>, leg.txid)
}

/**
 * One swap, either route: both legs, where it stands, and every transaction
 * of it on its own chain's explorer. The explorers are for the reader; the
 * wallet's own checks decide what the swap is.
 */
export function SwapDetailPanel({ swapId, chain }: { swapId: string; chain: Chain }) {
  const view = useSwapViews().find((v) => v.id === swapId)
  if (!view) {
    return (
      <div className="nav-child-panel" data-aeon-scope="swap-detail" data-aeon-state="missing">
        <EmptyState icon={<SwapIcon size={28} />} title="Swap not found" body="This swap is not recorded on this device." />
      </div>
    )
  }
  const exchangeId = view.route === 'exolix' ? view.id.slice('exolix:'.length) : null
  return (
    <div className="nav-child-panel payment-details" data-aeon-scope="swap-detail" data-aeon-state={view.tone} data-route={view.route}>
      <div className="payment-details-hero">
        <div className="history-icon-wrap">
          <SwapPairMark from={view.from} to={view.to} size={22} />
        </div>
        <div className="payment-details-copy">
          <div className="payment-details-title-row">
            <strong className="payment-details-title">{view.title}</strong>
            <SwapStatusPill tone={view.tone} />
          </div>
          <p className="history-when">{new Date(view.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</p>
        </div>
      </div>

      <div className="app-details-section">
        <SwapSummary pay={{ asset: view.from, units: view.pay, caption: 'You pay' }} receive={{ asset: view.to, units: view.receive, caption: 'You get' }} />
      </div>

      <div className="app-details-section">
        <dl className="wallet-details">
          <div className="wallet-detail">
            <span>Status</span>
            <span className="wallet-detail-value">{view.status}</span>
          </div>
          <div className="wallet-detail">
            <span>Route</span>
            <span className="wallet-detail-value" data-aeon-part="route">
              <SwapRouteBadge kind={view.route} />
              {SWAP_ROUTE_LABEL[view.route]}
            </span>
          </div>
          {exchangeId ? (
            <div className="wallet-detail">
              <span>Exchange</span>
              <button type="button" className="wallet-detail-value payment-details-woc" onClick={() => openExternal(`${EXOLIX_EXCHANGE_URL}${encodeURIComponent(exchangeId)}`)}>
                {exchangeId}
              </button>
            </div>
          ) : null}
          {view.legs.map((leg) => (
            <div className="wallet-detail" key={leg.txid} data-aeon-part="leg" data-aeon-state={leg.role}>
              <span>
                {SWAP_LEG_LABEL[leg.role]} · {SWAP_ASSET_INFO[leg.asset].ticker}
              </span>
              <button type="button" className="wallet-detail-value payment-details-woc" title={leg.txid} onClick={() => openExternal(legUrl(leg, chain))}>
                {short(leg.txid)}
              </button>
            </div>
          ))}
          {view.legs.length === 0 ? (
            <div className="wallet-detail">
              <span>Transactions</span>
              <span className="wallet-detail-value">None yet</span>
            </div>
          ) : null}
        </dl>
      </div>

      <Button.Root
        className="btn btn-ghost"
        variant="ghost"
        onClick={() => {
          playWalletSound('soft')
          openSwapFlow()
        }}
      >
        <Button.Label>Swap again</Button.Label>
      </Button.Root>
    </div>
  )
}
