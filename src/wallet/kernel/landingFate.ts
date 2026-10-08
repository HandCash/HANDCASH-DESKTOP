/**
 * Did an Arcade-accepted cheque reach the chain?
 *
 * Arcade's 202 means Arcade queued the body, nothing more. It then hands the
 * transaction to Teranode and reports what the network said on
 * `GET /tx/{txid}`. Teranode drops a transaction once every output is spent
 * and mined past its 288-block retention, then answers a spend of one of those
 * outputs with an opaque `PROCESSING` that Arcade files as a missing parent:
 * `PENDING_RETRY`, retried for a day. Reading the 202 as the send let a phone
 * sign a night of app payments on long-dead coins with every one shown as sent
 * (hc-a580a 0.1.540, 09c17bab2cd7: input spent by a tx mined 2026-09-22).
 *
 * `PENDING_RETRY` alone is not proof — a child of a still-propagating parent
 * reads the same. A cheque is only declared dead on evidence nobody can
 * dispute: a node's rejection (Arcade 466 names the spender), an input a node
 * or explorer names another spender for, or a parent this wallet already
 * proved dead. Anything on chain is landed, full stop. Silence keeps waiting.
 */

export type LandingArcade =
  /** A node, not just Arcade's queue, holds it. */
  | { kind: 'landed'; status: string }
  /** Arcade's 202 states: received, sent to network. */
  | { kind: 'queued'; status: string }
  /** No node gave a verdict; Arcade keeps retrying or gave up. */
  | { kind: 'stalled'; status: string; reason: string }
  | { kind: 'rejected'; reason: string; conflict?: { outpoint: string; spender: string } }
  | { kind: 'unknown' }

export type LandingEvidence = {
  /** Explorer existence; `null` when no explorer answered. */
  onChain: boolean | null
  /** Inputs a node or explorer says another transaction already spends. */
  spentElsewhere: Array<{ outpoint: string; spender: string }>
  /** Inputs whose funding transaction is already proven dead. */
  rejectedParents: string[]
}

export type LandingDeadCause =
  | 'arcade-rejected'
  | 'input-spent-elsewhere'
  | 'parent-rejected'

export type LandingFate =
  | { kind: 'landed'; reason: string }
  | { kind: 'dead'; cause: LandingDeadCause; reason: string }
  /** Ask the chain before deciding. */
  | { kind: 'gatherEvidence'; reason: string }
  | { kind: 'waiting'; reason: string }

/**
 * A 202 that has not reached a node by now is worth asking the chain about.
 * Arcade requeues an opaque Teranode `PROCESSING (4)` in memory with the row
 * still `RECEIVED` before it ever reads `PENDING_RETRY`, so waiting for that
 * status alone costs minutes on exactly the sends that will never land.
 */
export const QUEUED_EVIDENCE_AFTER_MS = 15_000

/** The spender Arcade's 466 named joins what the probes found. */
export function withArcadeConflict(
  evidence: LandingEvidence,
  arcade: LandingArcade,
): LandingEvidence {
  if (arcade.kind !== 'rejected' || !arcade.conflict) return evidence
  const { outpoint } = arcade.conflict
  if (evidence.spentElsewhere.some((s) => s.outpoint === outpoint)) return evidence
  return { ...evidence, spentElsewhere: [...evidence.spentElsewhere, arcade.conflict] }
}

export function decideLanding(facts: {
  arcade: LandingArcade
  elapsedMs: number
  evidence?: LandingEvidence
}): LandingFate {
  const { arcade } = facts
  if (arcade.kind === 'landed') {
    return { kind: 'landed', reason: `Arcade ${arcade.status}` }
  }
  if (facts.evidence?.onChain === true) return { kind: 'landed', reason: 'on chain' }

  if (!facts.evidence) {
    if (arcade.kind === 'rejected') {
      return { kind: 'gatherEvidence', reason: 'Arcade rejected — name the dead inputs' }
    }
    if (arcade.kind === 'stalled') {
      return { kind: 'gatherEvidence', reason: `Arcade ${arcade.status}: ${arcade.reason}` }
    }
    if (facts.elapsedMs >= QUEUED_EVIDENCE_AFTER_MS) {
      return { kind: 'gatherEvidence', reason: 'no network verdict yet' }
    }
    return { kind: 'waiting', reason: arcade.kind === 'queued' ? `Arcade ${arcade.status}` : 'Arcade silent' }
  }

  const evidence = withArcadeConflict(facts.evidence, arcade)
  if (evidence.spentElsewhere.length > 0) {
    const first = evidence.spentElsewhere[0]!
    return {
      kind: 'dead',
      cause: 'input-spent-elsewhere',
      reason: `${evidence.spentElsewhere.length} input(s) already spent by ${first.spender.slice(0, 12)}`,
    }
  }
  if (arcade.kind === 'rejected') {
    return { kind: 'dead', cause: 'arcade-rejected', reason: arcade.reason }
  }
  if (evidence.rejectedParents.length > 0) {
    return {
      kind: 'dead',
      cause: 'parent-rejected',
      reason: `spends change of dead tx ${evidence.rejectedParents[0]!.slice(0, 12)}`,
    }
  }
  return {
    kind: 'waiting',
    reason:
      arcade.kind === 'stalled'
        ? 'Arcade retrying; no input proven spent'
        : 'not on chain yet; no input proven spent',
  }
}
