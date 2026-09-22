/**
 * Does the Arcade submit pin still bind a signed cheque?
 *
 * The pin records that a broadcaster accepted our BEEF, so the transaction is
 * no longer ours alone to cancel: Activity keeps the row and the sealer sweep
 * keeps its inputs sealed until chain proof shows the spend failed. For a
 * transaction Arcade itself has rejected that proof never arrives — a rejected
 * transaction is never mined, so its inputs are never spent by it, so the row
 * and the coins behind it are held forever on evidence that cannot exist.
 *
 * Arcade issued the pin, so Arcade's own verdict retires it. `rejected` here is
 * already root-resolved by {@link fetchArcadeTxFate}: a "parent rejected …
 * retryable" chain counts only when its root is an objective rejection such as
 * `UTXO_SPENT`. Everything else — including silence — keeps the pin.
 */
export type ArcadeVerdict = 'accepted' | 'rejected' | 'pending' | 'unknown'

export type ArcadePinFate =
  | { kind: 'binds'; reason: string }
  | { kind: 'void'; reason: string }

export function decideArcadePinFate(facts: {
  /** A broadcaster accepted this BEEF on the initial postBeef round. */
  hasPin: boolean
  verdict: ArcadeVerdict
}): ArcadePinFate {
  if (!facts.hasPin) return { kind: 'void', reason: 'no Arcade contact' }
  switch (facts.verdict) {
    case 'rejected':
      return {
        kind: 'void',
        reason: 'Arcade rejected this transaction — it can never be mined',
      }
    case 'accepted':
      return { kind: 'binds', reason: 'Arcade accepted this transaction' }
    case 'pending':
      return { kind: 'binds', reason: 'Arcade is still working this transaction' }
    default:
      // Fail closed: silence is latency, not a cancellation.
      return { kind: 'binds', reason: 'Arcade verdict unavailable' }
  }
}
