/**
 * Explicit change-consolidation vocabulary.
 *
 * Coin selection over a badly fragmented managed-change pool is what makes
 * `createAction` slow to sign after many small BRC-29 receives. This module owns
 * the only question the background consolidation pass may ask: is the pool
 * fragmented enough that collapsing it into a single managed-change UTXO is worth
 * one self-payment fee?
 *
 * Same tagged-union pattern as `LegacySweepPath` / `TipKind` / `SendPath`
 * (`.cursor/rules/explicit-wallet-paths.mdc`): a future change cannot silently
 * start moving coins on a bare `count > N` test, and it can never touch assets —
 * the enumeration that feeds this only counts spendable managed change (baskets
 * other than `1sat` / `bsv21`).
 *
 * HARD RULES:
 * - fragments < MIN_FRAGMENTS_TO_CONSOLIDATE → skip (selection already cheap)
 * - totalSats <= estFee + MIN_NET_AFTER_FEE_SATS → skip (not worth the fee)
 * - otherwise → consolidate every spendable change output into one output
 */

/** Managed-change input bytes: 32 txid + 4 vout + 1 len + 107 unlock + 4 seq. */
const CONSOLIDATE_INPUT_BYTES = 148
/** Version + input/output counts + locktime, plus one P2PKH change output. */
const CONSOLIDATE_OVERHEAD_BYTES = 44
/** ARC's published `miningFee` (`GET /v1/policy`): 100 satoshis per 1000 bytes. */
const CONSOLIDATE_FEE_SATS_PER_KB = 100

/**
 * Below this the toolbox's own gradual pool management (`numberOfDesiredUTXOs`,
 * `maxChangeOutputsPerTransaction`) keeps selection fast enough, so a
 * consolidation would only pay a fee to save microseconds. Set above the
 * toolbox's working set so the pass only fires when the pool is genuinely
 * bloated by many small receives.
 */
export const MIN_FRAGMENTS_TO_CONSOLIDATE = 30

/**
 * Refuse to consolidate a nearly-empty fragmented wallet: after the fee there
 * must be something left worth having collapsed into one coin.
 */
export const MIN_NET_AFTER_FEE_SATS = 1_000

/** Estimated ARC fee to spend `fragments` inputs into one output. */
export function estimateConsolidationFeeSats(fragments: number): number {
  const inputs = Math.max(0, Math.floor(Number(fragments) || 0))
  const bytes = inputs * CONSOLIDATE_INPUT_BYTES + CONSOLIDATE_OVERHEAD_BYTES
  return Math.ceil((bytes * CONSOLIDATE_FEE_SATS_PER_KB) / 1000)
}

export type ConsolidationSkipReason = 'tooFewFragments' | 'belowFeeFloor'

export type ChangeConsolidationStats = {
  /** Spendable managed-change outputs (never `1sat` / `bsv21`). */
  fragments: number
  /** Sum of their satoshis. */
  totalSats: number
}

/**
 * Exhaustive answer to "should the background pass consolidate change now?"
 *
 * `consolidate` is the only path that may broadcast a self-payment; every skip
 * leaves the pool exactly as it is.
 */
export type ChangeConsolidationPlan =
  | { action: 'consolidate'; fragments: number; totalSats: number; estFeeSats: number }
  | {
      action: 'skip'
      reason: ConsolidationSkipReason
      fragments: number
      totalSats: number
    }

/**
 * Classify once. Callers must not invent a parallel `fragments > N` test — that
 * is how a future change could start moving coins on a bare count.
 */
export function planChangeConsolidation(
  stats: ChangeConsolidationStats,
): ChangeConsolidationPlan {
  const fragments = Math.max(0, Math.floor(Number(stats.fragments) || 0))
  const totalSats = Math.max(0, Math.floor(Number(stats.totalSats) || 0))

  if (fragments < MIN_FRAGMENTS_TO_CONSOLIDATE) {
    return { action: 'skip', reason: 'tooFewFragments', fragments, totalSats }
  }
  const estFeeSats = estimateConsolidationFeeSats(fragments)
  if (totalSats <= estFeeSats + MIN_NET_AFTER_FEE_SATS) {
    return { action: 'skip', reason: 'belowFeeFloor', fragments, totalSats }
  }
  return { action: 'consolidate', fragments, totalSats, estFeeSats }
}
