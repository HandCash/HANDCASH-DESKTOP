/**
 * The window where our own coins are deliberately nowhere.
 *
 * A self-consolidation collapses the change pool with one self-payment: it seals
 * the inputs it spent as soon as the transaction is signed, then internalizes the
 * single replacement output a few seconds later, after the broadcast verifies.
 * Between those two writes local state truthfully holds almost nothing — the old
 * coins are retired and their replacement does not exist yet.
 *
 * A balance read taken there is not a failed read; it is a *torn* read of a
 * mutation in progress. Publishing it showed a funded wallet as nearly empty
 * until a manual heal. So the rewrite is marked, and the balance view answers
 * `unavailable` while it is open — the same answer busy storage gives, which
 * every display path already handles by keeping the last real figure and every
 * spend gate handles by falling back to proven confirmed sats.
 *
 * This is not a lock. It changes no spend legality: the consolidation already
 * runs inside the exclusive spend region. It only stops a reader from believing
 * an intermediate state.
 */
let openWindows = 0

/**
 * Mark local funds as mid-rewrite until the returned function is called.
 *
 * Reference-counted, so nested or overlapping rewrites cannot leave the window
 * open, and idempotent per handle — calling the closer twice does not unbalance
 * the count.
 */
export function beginSelfFundsRewrite(): () => void {
  openWindows += 1
  let closed = false
  return () => {
    if (closed) return
    closed = true
    openWindows = Math.max(0, openWindows - 1)
  }
}

/** True while a signed self-payment has sealed inputs it has not yet replaced. */
export function selfFundsRewriteActive(): boolean {
  return openWindows > 0
}

/** Test-only — abandon any window a failed case left open. */
export function __resetSelfFundsRewriteForTests(): void {
  openWindows = 0
}
