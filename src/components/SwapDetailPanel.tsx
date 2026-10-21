import { Button } from '@aeon-ui/react'
import { useSwapViews } from '../features/swap'
import { openSwapFlow } from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import { SWAP_ASSET_INFO, type SwapAsset } from '../wallet/swap/assets'
import { SWAP_LEG_LABEL, SWAP_ROUTE_LABEL, signatureWaitText, type SwapLeg, type SwapView } from '../wallet/swap/swapView'
import { coinTxExplorerUrl, txExplorerUrl } from '../wallet/txExplorer'
import type { Chain } from '../wallet/vault'
import { EmptyState } from './EmptyState'
import { ConfirmationBadge } from './CoinDepositProgress'
import { CheckIcon, CoinGlyphIcon, SwapIcon } from './icons'
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

type SwapStep = { key: string; label: string; asset: SwapAsset; leg?: SwapLeg; state: 'done' | 'active' | 'pending'; confirming?: SwapView['confirming'] }

/** A wallet-to-wallet swap's three moves in the order they happen, the first unfinished one active. */
function directSteps(view: SwapView): SwapStep[] | null {
  if (view.route !== 'direct' || !view.role || (view.tone !== 'moving' && view.tone !== 'done')) return null
  const legOf = (role: SwapLeg['role']) => view.legs.find((leg) => leg.role === role)
  const confirmingOn = (asset: SwapAsset) => (view.confirming?.chain === asset ? view.confirming : undefined)
  const lock = (key: string, label: string, asset: SwapAsset, leg: SwapLeg | undefined) => ({ key, label, asset, leg, confirming: leg ? confirmingOn(asset) : undefined, done: !!leg && !confirmingOn(asset) })
  const own = lock('own', 'You lock', view.from, legOf('lock'))
  const peer = lock('peer', 'They lock', view.to, legOf('peer-lock'))
  const claim = legOf('claim')
  const receive = { key: 'receive', label: 'You receive', asset: view.to, leg: claim, confirming: undefined, done: !!claim || view.tone === 'done' }
  let reached = false
  return (view.role === 'taker' ? [own, peer, receive] : [peer, own, receive]).map(({ done, ...step }) => {
    const state = done ? 'done' : reached ? 'pending' : ((reached = true), 'active')
    return { ...step, state }
  })
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
  const steps = directSteps(view)
  const signing = view.tone === 'moving' ? signatureWaitText(view.signs, Date.now()) : null
  const stepTxids = new Set(steps?.flatMap((step) => (step.leg ? [step.leg.txid] : [])))
  const otherLegs = view.legs.filter((leg) => !stepTxids.has(leg.txid))
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

      {steps ? (
        <ol className="app-details-section" data-aeon-scope="swap-steps">
          {steps.map((step) => (
            <li key={step.key} data-aeon-state={step.state}>
              <span data-aeon-part="marker" aria-hidden>
                {step.state === 'done' ? <CheckIcon size={14} /> : <CoinGlyphIcon coin={step.asset} size={16} />}
              </span>
              <span data-aeon-part="label">
                {step.label} {SWAP_ASSET_INFO[step.asset].ticker}
              </span>
              {step.confirming ? (
                <ConfirmationBadge
                  chain={step.confirming.chain}
                  state={step.confirming.counted > 0 ? 'confirming' : 'unconfirmed'}
                  counted={step.confirming.counted}
                  needed={step.confirming.needed}
                  label={`${step.confirming.counted} of ${step.confirming.needed} confirmations`}
                />
              ) : step.leg ? (
                <button type="button" className="payment-details-woc" title={step.leg.txid} onClick={() => openExternal(legUrl(step.leg!, chain))}>
                  {short(step.leg.txid)}
                </button>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}

      <div className="app-details-section">
        <dl className="wallet-details">
          <div className="wallet-detail">
            <span>Status</span>
            <span className="wallet-detail-value">{view.status}</span>
          </div>
          {signing ? (
            <div className="wallet-detail" data-aeon-part="signing">
              <span>Your signature</span>
              <span className="wallet-detail-value" title="This swap needs this wallet to sign; auto-lock waits for it">
                {signing}
              </span>
            </div>
          ) : null}
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
          {otherLegs.map((leg) => (
            <div className="wallet-detail" key={leg.txid} data-aeon-part="leg" data-aeon-state={leg.role}>
              <span>
                {SWAP_LEG_LABEL[leg.role]} · {SWAP_ASSET_INFO[leg.asset].ticker}
              </span>
              <button type="button" className="wallet-detail-value payment-details-woc" title={leg.txid} onClick={() => openExternal(legUrl(leg, chain))}>
                {short(leg.txid)}
              </button>
            </div>
          ))}
          {view.legs.length === 0 && !steps ? (
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
