/**
 * One insufficient-funds explanation for every coin payment path.
 *
 * The displayed balance credits unconfirmed change of the user's own live
 * sends (see `balanceView.ts`), and so does the send gate — but `createAction`
 * can only select confirmed `spendable: true` outputs. After rapid sends almost
 * the whole balance can be change waiting on confirmation, so the gate passes
 * and the toolbox then throws `WERR_INSUFFICIENT_FUNDS`. Surfacing that raw
 * text tells the user they have no money while the hero number says otherwise.
 *
 * Every coin path (plain P2PKH and BRC-29 peer pay) must report the same split,
 * so the wording lives here rather than being re-derived per module.
 */
import { fetchBalanceSats } from './session'

export function isInsufficientFundsError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const name = err.name || ''
  const msg = err.message || ''
  return (
    name.includes('INSUFFICIENT_FUNDS') ||
    /insufficient.?funds/i.test(msg) ||
    /more satoshis are needed/i.test(msg)
  )
}

function bsv(satoshis: number): string {
  const clamped = Math.max(0, Math.trunc(satoshis))
  return (clamped / 1e8)
    .toFixed(8)
    .replace(/0+$/, '')
    .replace(/\.$/, '')
}

/**
 * Wording for a spend the wallet could not fund.
 *
 * `confirmingSats` only earns the "still confirming" message when it actually
 * closes the gap — otherwise the user is genuinely short and saying "wait"
 * would be a lie they could wait on forever.
 */
export function insufficientFundsMessage(opts: {
  confirmedSats: number
  confirmingSats: number
  neededSats: number
}): string {
  const confirmed = Math.max(0, Math.trunc(opts.confirmedSats))
  const confirming = Math.max(0, Math.trunc(opts.confirmingSats))
  const needed = Math.max(0, Math.trunc(opts.neededSats))

  if (confirming > 0 && confirmed + confirming >= needed) {
    return `Your funds are still confirming. ${bsv(confirmed)} BSV is spendable now and ${bsv(confirming)} BSV is waiting for confirmation. Try again once it clears.`
  }
  return `Not enough spendable BSV: ${bsv(confirmed)} spendable now, need ${bsv(needed)} plus network fee.`
}

/** Read the live confirmed / confirming split and describe the shortfall. */
export async function describeInsufficientFunds(
  wallet: Parameters<typeof fetchBalanceSats>[0],
  neededSats: number,
): Promise<string> {
  const confirmedSats = await fetchBalanceSats(wallet, {
    creditUnconfirmed: false,
  }).catch(() => 0)
  let confirmingSats = 0
  try {
    const { unconfirmedChangeSats } = await import('./balanceView')
    confirmingSats = await unconfirmedChangeSats()
  } catch {
    // Best-effort; fall back to the confirmed-only wording.
  }
  return insufficientFundsMessage({ confirmedSats, confirmingSats, neededSats })
}
