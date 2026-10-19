import type { ActivitySwap } from '../../wallet/appActivity'
import { openSwapDetails } from '../../wallet/navStore'
import { playWalletSound } from '../../wallet/soundService'
import { SWAP_ROUTE_LABEL } from '../../wallet/swap/swapView'
import { LoadingSpinner } from '../LoadingSpinner'
import { SwapPairMark } from '../SwapVisuals'

/** A swap that ended without one says so where a send says "Failed". */
const ENDED: Partial<Record<ActivitySwap['tone'], string>> = { returned: 'Refunded', stopped: 'Stopped' }

/**
 * One swap in Activity, laid out like every other row: what it is, where it
 * stands, what lands in this wallet, and when. Its deposit, locks, claim and
 * refund fold under it; the row opens the swap with each of them.
 */
export function SwapActivityRow({
  swap,
  rowKey,
  amount,
  when,
  newest = false,
}: {
  swap: ActivitySwap
  rowKey: string
  /** What this wallet receives, priced like the rest of the feed. */
  amount: string
  /** The time slot when the feed shows times; a moving swap says so instead. */
  when: string | null
  newest?: boolean
}) {
  const moving = swap.tone === 'moving'
  const ended = ENDED[swap.tone]
  const subtitle = `${SWAP_ROUTE_LABEL[swap.route]} · ${swap.status}`
  return (
    <li
      data-activity-key={rowKey}
      data-activity-newest={newest ? '' : undefined}
      data-activity-pending={moving ? '' : undefined}
      data-aeon-scope="activity-row"
      data-aeon-part="swap"
      data-aeon-state={swap.tone}
    >
      <button
        type="button"
        className="history-row history-row-btn"
        onClick={() => {
          playWalletSound('soft')
          openSwapDetails(swap.id)
        }}
      >
        <div className="history-icon-wrap">
          <SwapPairMark from={swap.from} to={swap.to} size={22} />
          {moving ? (
            <span className="history-pending-mark" aria-live="polite" aria-label="Swapping" title="Swapping">
              <LoadingSpinner size="sm" />
            </span>
          ) : null}
        </div>
        <div className="history-body history-progress-body">
          <strong className="history-title">{swap.title}</strong>
          <span className="history-when" title={subtitle}>
            {subtitle}
          </span>
        </div>
        <div className="history-amount-block">
          <span className={ended ? 'history-amount history-amount-item' : 'history-amount'} title={amount}>
            {ended ?? `+${amount}`}
          </span>
          {when ? (
            <span className="history-when" data-aeon-part="row-state">
              {moving ? 'Swapping…' : when}
            </span>
          ) : null}
        </div>
      </button>
    </li>
  )
}
