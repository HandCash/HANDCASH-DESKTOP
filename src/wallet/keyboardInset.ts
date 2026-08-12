/**
 * Keep mobile focused fields visible when the soft keyboard opens.
 *
 * Do not shrink the app shell to the visual viewport — that collapses flex
 * layouts (Activity → almost nothing). Android should use adjustPan so the
 * OS shifts the window; we only scroll the focused control into view.
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
    const inset = Math.max(0, layoutH - visibleH - offsetTop)
    // Inset is informational / scroll-margin only — never drive shell height.
    root.style.setProperty('--keyboard-inset', `${inset}px`)
    root.classList.toggle('keyboard-open', inset > 40)
  }

  const scrollFocusedIntoView = () => {
    const el = document.activeElement
    if (!(el instanceof HTMLElement)) return
    if (!el.matches('input, textarea, select, [contenteditable="true"]')) return
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
    window.setTimeout(scrollFocusedIntoView, 80)
    window.setTimeout(scrollFocusedIntoView, 280)
  })
  document.addEventListener('focusout', () => {
    window.setTimeout(sync, 80)
  })
  sync()

  ;(window as Window & { __handcashKeyboardSync?: () => void }).__handcashKeyboardSync =
    sync
  ;(
    window as Window & { __handcashKeyboardScrollFocused?: () => void }
  ).__handcashKeyboardScrollFocused = scrollFocusedIntoView
}

/** Capacitor Keyboard height — scroll focused field; do not resize the shell. */
export function applyCapacitorKeyboardHeight(heightPx: number): void {
  if (typeof window === 'undefined') return
  const root = document.documentElement
  const h = Math.max(0, Math.round(heightPx))
  root.style.setProperty('--keyboard-inset', `${h}px`)
  root.classList.toggle('keyboard-open', h > 40)
  if (h > 0) {
    ;(
      window as Window & { __handcashKeyboardScrollFocused?: () => void }
    ).__handcashKeyboardScrollFocused?.()
  }
}
