/**
 * When a balance read may re-run the pending-change promotion.
 *
 * Pure like {@link ./txLiveness}: no session, storage, chain, or UI imports, so
 * balance projection can depend on it without pulling the wallet in.
 *
 * The promotion is armed by the balance breakdown log, and a promotion that
 * moves nothing used to invalidate that log — so the same breakdown was written
 * again, arming the next pass. Change that cannot be promoted (an unmined tx
 * with no proof) therefore paged unspendable change forever, blocking the
 * renderer for over a second each cycle, with the displayed balance never
 * changing.
 */
export type ChainedChangeHealState = {
  /** Pending amount the last attempt failed to move; -1 when none. */
  stuckSats: number
  /** When that failure was recorded. */
  stuckAt: number
  /** When the last attempt ran, successful or not. */
  lastAttemptAt: number
  /** An attempt is still running. */
  inFlight: boolean
}

export type ChainedChangeHealDecision =
  | { run: true }
  | { run: false; reason: 'noPendingChange' | 'knownStuck' | 'cooldown' | 'inFlight' }

export const CHAINED_CHANGE_HEAL_COOLDOWN_MS = 12_000
/** A stuck amount is retried this rarely, in case the tx became promotable. */
export const CHAINED_CHANGE_HEAL_STUCK_RETRY_MS = 10 * 60_000

export function decideChainedChangeHeal(args: {
  pendingChange: number
  now: number
  state: ChainedChangeHealState
}): ChainedChangeHealDecision {
  const { pendingChange, now, state } = args
  if (!(pendingChange > 0)) return { run: false, reason: 'noPendingChange' }
  if (state.inFlight) return { run: false, reason: 'inFlight' }
  if (
    pendingChange === state.stuckSats &&
    now - state.stuckAt < CHAINED_CHANGE_HEAL_STUCK_RETRY_MS
  ) {
    return { run: false, reason: 'knownStuck' }
  }
  if (now - state.lastAttemptAt < CHAINED_CHANGE_HEAL_COOLDOWN_MS) {
    return { run: false, reason: 'cooldown' }
  }
  return { run: true }
}
