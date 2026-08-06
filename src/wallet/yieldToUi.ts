/** Yield so wallet sync work does not monopolise the UI thread. */
export function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => resolve(), { timeout: 120 })
      return
    }
    setTimeout(resolve, 0)
  })
}
