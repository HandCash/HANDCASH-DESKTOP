/**
 * Classify miner / Arcade / createAction rejection *text*.
 *
 * MissingInputs alone is ghost / incomplete-BEEF noise, not proof an input
 * left the wallet. Already-spent / double-spend wording is the listing bar.
 */

export type SpendArcadeKind =
  | 'accepted'
  | 'ancestryIncomplete'
  | 'ghostMissingInputs'
  | 'alreadySpent'
  | 'unknown'

export function classifySpendFailureMessage(reason: string): SpendArcadeKind {
  const text = reason.trim()
  if (!text) return 'unknown'
  const lower = text.toLowerCase()
  if (/ancestry.?incomplete|beef_ancestry_incomplete|beef ancestry incomplete/i.test(text)) {
    return 'ancestryIncomplete'
  }
  const alreadySpent =
    /already.?spent/i.test(text) || /double.?spend/i.test(text) || /doublespend/i.test(lower)
  const missingInputs =
    /missing.?inputs/i.test(text) ||
    /missingorspent/i.test(lower) ||
    /mempool-conflict/i.test(lower)
  if (alreadySpent) return 'alreadySpent'
  if (missingInputs) return 'ghostMissingInputs'
  return 'unknown'
}

/** Listing / market: MissingInputs-only is not already-spent. */
export function isAlreadySpentListingFailure(reason: string): boolean {
  return classifySpendFailureMessage(reason) === 'alreadySpent'
}

export function isGhostMissingInputsMessage(reason: string): boolean {
  return classifySpendFailureMessage(reason) === 'ghostMissingInputs'
}

/**
 * createAction hide-inputs: missing inputs *or* already spent.
 * Not proof the UTXO is gone — callers still probe the chain.
 */
export function isAlreadySpentInputError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  const kind = classifySpendFailureMessage(message)
  return kind === 'alreadySpent' || kind === 'ghostMissingInputs'
}
