/**
 * Background wallet work waits for the user to stop scrolling.
 *
 * `yieldToUi` bounds how long one task holds the thread, but a single BEEF
 * parse or proof check is still one long task, and starting one mid-fling is a
 * visible hitch. Work that nobody is waiting on (BRC-150 verification of
 * cards, progress repaints) starts only after input has been quiet for
 * {@link QUIET_MS}. A cap keeps it from starving behind endless scrolling.
 */

const QUIET_MS = 220
export const INPUT_QUIET_MAX_WAIT_MS = 8_000

const now = (): number =>
  typeof performance?.now === 'function' ? performance.now() : Date.now()

let lastInputAt = Number.NEGATIVE_INFINITY
let installed = false

function noteInput(): void {
  lastInputAt = now()
}

function install(): void {
  if (installed) return
  installed = true
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
  const opts: AddEventListenerOptions = { capture: true, passive: true }
  for (const type of ['scroll', 'wheel', 'touchstart', 'touchmove', 'pointerdown']) {
    window.addEventListener(type, noteInput, opts)
  }
}

/** True while the user scrolled or touched within the last {@link QUIET_MS}. */
export function isInputActive(at = now()): boolean {
  install()
  return at - lastInputAt < QUIET_MS
}

/** Resolves once input has been quiet, or after `maxWaitMs` regardless. */
export function whenInputQuiet(maxWaitMs = INPUT_QUIET_MAX_WAIT_MS): Promise<void> {
  install()
  if (!isInputActive()) return Promise.resolve()
  const giveUpAt = now() + maxWaitMs
  return new Promise((resolve) => {
    const check = () => {
      const t = now()
      if (!isInputActive(t) || t >= giveUpAt) {
        resolve()
        return
      }
      const untilQuiet = QUIET_MS - (t - lastInputAt)
      setTimeout(check, Math.max(16, Math.min(untilQuiet, giveUpAt - t)))
    }
    check()
  })
}

/** Test seam: pretend the user just scrolled. */
export function noteInputForTest(): void {
  install()
  noteInput()
}
