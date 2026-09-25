/**
 * Yield so wallet sync work does not monopolise the UI thread.
 *
 * Prefer `scheduler.yield()` when present — Chromium prioritises input over
 * continuation, which is what makes typing/clicks survive BEEF merges and
 * IndexedDB seal loops. Fall back to a MessageChannel microtask (faster than
 * `setTimeout(0)`, which browsers clamp to ~4ms). Never use
 * `requestIdleCallback`: during ingest the main thread stays busy, so ric
 * waited out its full timeout on every call and made Electron feel slower
 * than Android WebViews that lacked ric.
 */

/** Longest the wallet may hold the main thread before the UI must get a turn. */
const HOLD_BUDGET_MS = 24

const now = (): number =>
  typeof performance?.now === 'function' ? performance.now() : Date.now()

let heldSince = now()

function markResumed(): void {
  heldSince = now()
}

export function yieldToUi(): Promise<void> {
  const sched = (globalThis as { scheduler?: { yield?: () => Promise<void> } })
    .scheduler
  if (typeof sched?.yield === 'function') {
    return sched.yield().then(markResumed)
  }
  return new Promise<void>((resolve) => {
    const resume = () => {
      markResumed()
      resolve()
    }
    if (typeof MessageChannel === 'function') {
      const { port1, port2 } = new MessageChannel()
      port1.onmessage = resume
      port2.postMessage(null)
      return
    }
    setTimeout(resume, 0)
  })
}

/**
 * Has this task held the main thread past {@link HOLD_BUDGET_MS}?
 *
 * Loops used to yield every N iterations, which bounds iterations and not time:
 * when one iteration cost ~500ms, `i % 8` produced a four-second task and the
 * app froze for as long as the loop ran (lab phone hc-a580a: 4s tasks at a 90%
 * duty cycle for over a minute of unlock recompose). Guard the yield with this
 * instead — `if (uiBudgetExpired()) await yieldToUi()`.
 *
 * The check is synchronous on purpose. An unconditional `await` costs a
 * microtask tick even when it resolves immediately, which is enough to let a
 * concurrent basket read interleave mid-loop.
 */
export function uiBudgetExpired(): boolean {
  return now() - heldSince >= HOLD_BUDGET_MS
}
