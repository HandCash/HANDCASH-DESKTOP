/**
 * Yield so wallet sync work does not monopolise the UI thread.
 *
 * Always `setTimeout(0)`. `requestIdleCallback` was wrong here: during ingest
 * the main thread stays busy, so ric waited out its full timeout (~120ms) on
 * every call. A soft-latch import alone yields four times — Electron (which has
 * ric) paid ~half a second of artificial lag per latch while Android WebViews
 * (often no ric) fell through to setTimeout and felt snappier. The goal is to
 * let paint/input run between CPU bursts, not to wait until the browser is idle.
 */
export function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}
