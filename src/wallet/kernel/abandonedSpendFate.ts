/**
 * Fate of a signed local spend that never landed.
 *
 * A locally signed transaction is a cheque: explorer absence is latency, not a
 * cancellation, so the sealer sweep refuses to revive its inputs on a 404. That
 * is right, but `unsent` with no Arcade contact and no competing spend was left
 * *unclassified* — neither live nor dead — which is a permanent state. The
 * inputs stay sealed and the change stays unpromotable, so the coins sit
 * outside both spendable and pendingChange indefinitely.
 *
 * The exit is the Arcade contact. That pin records that a broadcaster actually
 * accepted the BEEF. Without one we never handed the cheque to anybody, so no
 * counterparty can present it — and if every input is still verifiably unspent
 * on chain, nothing has moved. Reclaiming then risks nothing, because the only
 * party who could ever broadcast that transaction is us.
 */

/**
 * `phantom` is an outpoint whose funding transaction is itself definitively
 * absent from the chain — change from an earlier spend that never landed.
 *
 * It is not the same as `unknown`. An outpoint that does not exist can never be
 * spent by anyone, so a transaction consuming one can never become valid. Left
 * as `unknown` it froze whole chains of unbroadcast spends in place, and with
 * them the real coins sealed alongside the phantom input.
 */
export type InputSpentStatus = 'unspent' | 'spent' | 'unknown' | 'phantom'

export type AbandonedSpendFacts = {
  /** A broadcaster accepted this BEEF, so somebody else may still land it. */
  hasArcadeContact: boolean
  /** Explorer existence. `null` when no explorer could answer. */
  onChain: boolean | null
  /** On-chain status of every input this transaction would spend. */
  inputs: InputSpentStatus[]
  /** When the transaction row was created. */
  createdAt: number
  now: number
}

export type AbandonedSpendFate =
  | { kind: 'keep'; reason: string }
  | { kind: 'abandoned'; reason: string }

/**
 * Long enough that a send still working through submit, retry, and propagation
 * is never mistaken for an abandoned one.
 */
export const ABANDON_GRACE_MS = 6 * 60 * 60_000

export function decideAbandonedSpend(facts: AbandonedSpendFacts): AbandonedSpendFate {
  if (facts.onChain === true) return { kind: 'keep', reason: 'on chain' }

  // Absence has to be positively established; `null` is "nobody answered".
  if (facts.onChain !== false) return { kind: 'keep', reason: 'chain absence unconfirmed' }

  // Somebody else can still land it — the competing-spend path owns this case.
  if (facts.hasArcadeContact) return { kind: 'keep', reason: 'Arcade-pinned' }

  if (facts.inputs.length === 0) return { kind: 'keep', reason: 'inputs unknown' }
  if (facts.inputs.some((s) => s === 'unknown')) {
    return { kind: 'keep', reason: 'input status unconfirmed' }
  }
  // An input that moved is a conflict, decided by proof elsewhere, not here.
  if (facts.inputs.some((s) => s === 'spent')) {
    return { kind: 'keep', reason: 'input already spent elsewhere' }
  }

  const createdAt = Number.isFinite(facts.createdAt) ? facts.createdAt : 0
  // An unknown creation time reads as brand new, which keeps the cheque.
  if (createdAt <= 0) return { kind: 'keep', reason: 'age unknown' }
  if (facts.now - createdAt < ABANDON_GRACE_MS) {
    return { kind: 'keep', reason: 'within grace window' }
  }

  if (facts.inputs.every((s) => s === 'phantom')) {
    return {
      kind: 'abandoned',
      reason: 'never broadcast — every input is change from a spend that never landed',
    }
  }

  return {
    kind: 'abandoned',
    reason: 'never broadcast — no Arcade pin, absent on chain, no input has moved',
  }
}
