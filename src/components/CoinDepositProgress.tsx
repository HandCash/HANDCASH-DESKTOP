import { stateToAttr } from '@aeon-ui/core'
import { COIN_INFO, formatCoin, type CoinChain } from '../wallet/coins/coinChains'
import { depositCount, describeDeposit, type CoinDepositPhase, type CoinDepositView } from '../wallet/coins/depositPhase'

/** One mark per confirmation needed, the first `counted` filled. */
function ConfirmationPips({ state, counted, needed, label, title }: { state: string; counted: number; needed: number; label: string; title?: string }) {
  return (
    <span data-aeon-part="pips" data-aeon-state={state} data-many={needed > 10 ? '' : undefined} role="img" aria-label={label} title={title ?? label}>
      {Array.from({ length: needed }, (_, i) => (
        <span key={i} data-aeon-part="pip" data-aeon-state={i < counted ? 'counted' : 'open'} />
      ))}
    </span>
  )
}

/**
 * Marks and a count for anything on a chain waiting on blocks: a received
 * coin, or a swap's lock. Counts are only what this wallet established;
 * nothing is interpolated.
 */
export function ConfirmationBadge({
  chain,
  state,
  counted,
  needed,
  label,
  title,
}: {
  chain: CoinChain | 'bsv' | 'arc-usd'
  state: string
  counted: number
  needed: number
  label: string
  title?: string
}) {
  return (
    <span data-aeon-scope="coin-deposit" data-aeon-state={state} data-aeon-part="badge" data-chain={chain}>
      <ConfirmationPips state={state} counted={counted} needed={needed} label={label} title={title} />
      {counted < needed ? <span data-aeon-part="count">{`${counted}/${needed}`}</span> : null}
    </span>
  )
}

/**
 * One mark per confirmation the coin needs. Only counts this wallet's own
 * header chain for the coin established are filled; nothing is interpolated.
 */
export function CoinDepositPips({ chain, phase }: { chain: CoinChain; phase: CoinDepositPhase }) {
  const { counted, needed } = depositCount(chain, phase)
  const copy = describeDeposit(chain, phase)
  return <ConfirmationPips state={stateToAttr(phase.kind)} counted={counted} needed={needed} label={copy.status} title={`${copy.status}\n${copy.source}`} />
}

/** "3/6", from this wallet's own count; null once the coin can move. */
export function depositShortCount(chain: CoinChain, phase: CoinDepositPhase): string | null {
  if (phase.kind === 'movable') return null
  const { counted, needed } = depositCount(chain, phase)
  return `${counted}/${needed}`
}

/** Compact: marks and the count, for a chip or an activity row. The full wording rides the title. */
export function CoinDepositBadge({ chain, phase }: { chain: CoinChain; phase: CoinDepositPhase }) {
  const short = depositShortCount(chain, phase)
  return (
    <span data-aeon-scope="coin-deposit" data-aeon-state={stateToAttr(phase.kind)} data-aeon-part="badge" data-chain={chain}>
      <CoinDepositPips chain={chain} phase={phase} />
      {short ? <span data-aeon-part="count">{short}</span> : null}
    </span>
  )
}

/** Full: what the coin's state is, who established it and when, and a labelled estimate. */
export function CoinDepositProgress({ chain, view, showAmount = true }: { chain: CoinChain; view: CoinDepositView; showAmount?: boolean }) {
  const copy = describeDeposit(chain, view.phase)
  return (
    <div data-aeon-scope="coin-deposit" data-aeon-state={stateToAttr(view.phase.kind)} data-aeon-part="progress" data-chain={chain}>
      <div data-aeon-part="headline">
        {showAmount ? (
          <strong data-aeon-part="amount">
            {formatCoin(chain, BigInt(view.litoshi))} {COIN_INFO[chain].ticker}
          </strong>
        ) : null}
        <CoinDepositPips chain={chain} phase={view.phase} />
      </div>
      <p data-aeon-part="status">{copy.status}</p>
      <p data-aeon-part="source">{copy.source}</p>
      {copy.estimate ? <p data-aeon-part="estimate">{copy.estimate}</p> : null}
    </div>
  )
}
