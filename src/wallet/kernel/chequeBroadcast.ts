/**
 * Whether a signed Atomic BEEF may leave the device.
 *
 * Incomplete ancestry is not a spent coin. Miners answer MissingInputs for
 * both; treating the first as poison is how unconfirmed change gets hidden.
 * This decision is local and cheap: subject body + parent bodies or parent
 * merkle already in the package. It does not wait for this tx to be mined.
 */

export type BeefAncestryGap = 'none' | 'unconfirmed-parents' | 'missing-bodies'

export type ChequeBroadcastDecision =
  | { kind: 'broadcast'; parents: 'header-proven' | 'unconfirmed-bodies' }
  | { kind: 'refuse'; reason: 'subject-missing' | 'missing-bodies' }

export function decideChequeBroadcast(args: {
  subjectBodyPresent: boolean
  gap: BeefAncestryGap
}): ChequeBroadcastDecision {
  if (!args.subjectBodyPresent) {
    return { kind: 'refuse', reason: 'subject-missing' }
  }
  if (args.gap === 'missing-bodies') {
    return { kind: 'refuse', reason: 'missing-bodies' }
  }
  return {
    kind: 'broadcast',
    parents: args.gap === 'none' ? 'header-proven' : 'unconfirmed-bodies',
  }
}

/**
 * A miner MissingInputs on an unconfirmed-parent package is still unconfirmed
 * chain state. Only header-proven parents make MissingInputs look like poison.
 */
export function interpretMissingInputs(
  decision: ChequeBroadcastDecision,
): 'still-unconfirmed' | 'possible-spent' | 'incomplete-package' {
  if (decision.kind === 'refuse') return 'incomplete-package'
  if (decision.parents === 'unconfirmed-bodies') return 'still-unconfirmed'
  return 'possible-spent'
}
