import { describeLtcDeposit, ltcDepositCount, type LtcDepositPhase, type LtcDepositView } from '../wallet/wltc/depositPhase'
import { formatLtc } from '../wallet/wltc/litecoin'

/**
 * One mark per confirmation the deposit needs. Only counts this wallet's own
 * Litecoin header chain established are filled; nothing is interpolated.
 */
export function LtcDepositPips({ phase }: { phase: LtcDepositPhase }) {
  const { counted, needed } = ltcDepositCount(phase)
  const copy = describeLtcDeposit(phase)
  return (
    <span data-aeon-part="pips" data-aeon-state={phase.kind} role="img" aria-label={copy.status} title={`${copy.status}\n${copy.source}`}>
      {Array.from({ length: needed }, (_, i) => (
        <span key={i} data-aeon-part="pip" data-aeon-state={i < counted ? 'counted' : 'open'} />
      ))}
    </span>
  )
}

/** "3/6", from this wallet's own count; null once the deposit can move. */
export function ltcDepositShortCount(phase: LtcDepositPhase): string | null {
  if (phase.kind === 'movable') return null
  const { counted, needed } = ltcDepositCount(phase)
  return `${counted}/${needed}`
}

/** Compact: marks and the count, for a chip or an activity row. The full wording rides the title. */
export function LtcDepositBadge({ phase }: { phase: LtcDepositPhase }) {
  const short = ltcDepositShortCount(phase)
  return (
    <span data-aeon-scope="ltc-deposit" data-aeon-state={phase.kind} data-aeon-part="badge">
      <LtcDepositPips phase={phase} />
      {short ? <span data-aeon-part="count">{short}</span> : null}
    </span>
  )
}

/** Full: what the deposit's state is, who established it and when, and a labelled estimate. */
export function LtcDepositProgress({ view, showAmount = true }: { view: LtcDepositView; showAmount?: boolean }) {
  const copy = describeLtcDeposit(view.phase)
  return (
    <div data-aeon-scope="ltc-deposit" data-aeon-state={view.phase.kind} data-aeon-part="progress">
      <div data-aeon-part="headline">
        {showAmount ? <strong data-aeon-part="amount">{formatLtc(BigInt(view.litoshi))} LTC</strong> : null}
        <LtcDepositPips phase={view.phase} />
      </div>
      <p data-aeon-part="status">{copy.status}</p>
      <p data-aeon-part="source">{copy.source}</p>
      {copy.estimate ? <p data-aeon-part="estimate">{copy.estimate}</p> : null}
    </div>
  )
}
