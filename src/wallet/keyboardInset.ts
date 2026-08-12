/**
 * Keep sticky footers / tab bars above the soft keyboard on Android WebViews
 * that pan instead of resize (and as a belt for adjustResize).
 */
export function installKeyboardInset(): void {
  if (typeof window === 'undefined') return
  const vv = window.visualViewport
  if (!vv) return

  const root = document.documentElement
  const sync = () => {
    const inset = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))
    root.style.setProperty('--keyboard-inset', `${inset}px`)
    root.classList.toggle('keyboard-open', inset > 48)
  }

  vv.addEventListener('resize', sync)
  vv.addEventListener('scroll', sync)
  window.addEventListener('orientationchange', sync)
  sync()
}
