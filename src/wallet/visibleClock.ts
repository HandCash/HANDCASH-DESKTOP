/**
 * A clock that only runs while the page is visible.
 *
 * Android throttles a hidden WebView's timers against a background CPU budget,
 * so wall time stops measuring how long wallet work actually ran: a migrate
 * that signs in seconds on screen can take minutes behind another app. A
 * watchdog that means "this work stopped responding" has to count the time the
 * work could have run, not the time the phone spent in a pocket.
 */

let hiddenTotalMs = 0
let hiddenSince: number | null = null
let installed = false

function install(): void {
  if (installed || typeof document === 'undefined') return
  installed = true
  if (document.visibilityState === 'hidden') hiddenSince = Date.now()
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenSince ??= Date.now()
    } else if (hiddenSince != null) {
      hiddenTotalMs += Date.now() - hiddenSince
      hiddenSince = null
    }
  })
}

/** Milliseconds on a clock that stands still while the page is hidden. */
export function visibleNow(): number {
  install()
  const now = Date.now()
  return now - hiddenTotalMs - (hiddenSince == null ? 0 : now - hiddenSince)
}

/**
 * Like `setTimeout`, but fires once `ms` of *visible* time has passed. Returns
 * a cancel function.
 */
export function setVisibleTimeout(task: () => void, ms: number): () => void {
  const startedAt = visibleNow()
  let timer: ReturnType<typeof setTimeout> | undefined
  const check = () => {
    const ran = visibleNow() - startedAt
    if (ran >= ms) {
      timer = undefined
      task()
      return
    }
    timer = setTimeout(check, Math.max(1_000, ms - ran))
  }
  timer = setTimeout(check, ms)
  return () => {
    if (timer) clearTimeout(timer)
    timer = undefined
  }
}
