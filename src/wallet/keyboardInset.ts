/**
 * Keep mobile UI above the soft keyboard.
 *
 * Android WebViews often pan (top clipped) or ignore adjustResize when the
 * shell is locked to 100dvh. Track the visual viewport, expose CSS vars, and
 * scroll the focused field into view so nothing sits under the keyboard.
 */
export function installKeyboardInset(): void {
  if (typeof window === 'undefined') return
  const root = document.documentElement
  if (!root.classList.contains('platform-mobile')) return

  const vv = window.visualViewport

  const sync = () => {
    const layoutH = window.innerHeight
    const visibleH = vv ? Math.round(vv.height) : layoutH
    const offsetTop = vv ? Math.round(vv.offsetTop) : 0
    // Prefer visualViewport when the OS pans; fall back to innerHeight shrink.
    const inset = Math.max(0, layoutH - visibleH - offsetTop)
    root.style.setProperty('--keyboard-inset', `${inset}px`)
    root.style.setProperty('--vv-height', `${visibleH}px`)
    root.style.setProperty('--vv-offset-top', `${offsetTop}px`)
    root.classList.toggle('keyboard-open', inset > 40)
  }

  const scrollFocusedIntoView = () => {
    const el = document.activeElement
    if (!(el instanceof HTMLElement)) return
    if (!el.matches('input, textarea, select, [contenteditable="true"]')) return
    // After the viewport settles, keep the caret / field above the keyboard
    // and above the sticky tab / action bars.
    window.requestAnimationFrame(() => {
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })
    })
  }

  if (vv) {
    vv.addEventListener('resize', sync)
    vv.addEventListener('scroll', sync)
  }
  window.addEventListener('resize', sync)
  window.addEventListener('orientationchange', sync)
  document.addEventListener('focusin', () => {
    sync()
    // Delay past the keyboard animation on Android.
    window.setTimeout(scrollFocusedIntoView, 80)
    window.setTimeout(scrollFocusedIntoView, 280)
  })
  document.addEventListener('focusout', () => {
    window.setTimeout(sync, 80)
  })
  sync()

  // Optional hook for Capacitor Keyboard plugin (wired from mobile shell).
  ;(window as Window & { __handcashKeyboardSync?: () => void }).__handcashKeyboardSync =
    sync
  ;(
    window as Window & { __handcashKeyboardScrollFocused?: () => void }
  ).__handcashKeyboardScrollFocused = scrollFocusedIntoView
}

/** Apply an explicit keyboard height from Capacitor Keyboard events. */
export function applyCapacitorKeyboardHeight(heightPx: number): void {
  if (typeof window === 'undefined') return
  const root = document.documentElement
  const h = Math.max(0, Math.round(heightPx))
  root.style.setProperty('--keyboard-inset', `${h}px`)
  root.classList.toggle('keyboard-open', h > 40)
  ;(
    window as Window & { __handcashKeyboardSync?: () => void }
  ).__handcashKeyboardSync?.()
  if (h > 0) {
    ;(
      window as Window & { __handcashKeyboardScrollFocused?: () => void }
    ).__handcashKeyboardScrollFocused?.()
  }
}
