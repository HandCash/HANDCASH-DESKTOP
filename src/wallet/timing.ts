/**
 * The one home for waiting and deadlines. Do not define a local `sleep`,
 * `delay`, `withTimeout` or `timeoutSignal`; `src/sharedHelpers.test.ts` fails
 * the build when one appears.
 */

/** Resolve after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

/**
 * Settle as `work` settles, or reject with `new Error(message)` once `ms`
 * passes first. The timer is always cleared. `work` keeps running after a
 * timeout; its late result is ignored, never an unhandled rejection.
 */
export async function withTimeout<T>(work: Promise<T>, ms: number, message = 'timeout'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * A signal that aborts after `ms` milliseconds, for `fetch(url, { signal })`.
 * Undefined on runtimes without `AbortSignal.timeout` (the request then has no
 * deadline).
 */
export function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(ms) : undefined
}
