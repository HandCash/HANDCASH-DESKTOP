/**
 * Promise-tail serializer — overlapping callers run one-at-a-time.
 * Failures do not break the queue for subsequent work.
 */
export function createSerialQueue(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(fn, fn)
    tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}
