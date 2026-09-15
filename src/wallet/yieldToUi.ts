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
export function yieldToUi(): Promise<void> {
  const sched = (globalThis as { scheduler?: { yield?: () => Promise<void> } })
    .scheduler
  if (typeof sched?.yield === 'function') {
    return sched.yield()
  }
  return new Promise((resolve) => {
    if (typeof MessageChannel === 'function') {
      const { port1, port2 } = new MessageChannel()
      port1.onmessage = () => resolve()
      port2.postMessage(null)
      return
    }
    setTimeout(resolve, 0)
  })
}
