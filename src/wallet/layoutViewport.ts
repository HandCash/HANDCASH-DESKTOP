/**
 * Desktop (and browser) viewport layout mode for tiled WMs / portrait frames.
 *
 * Phone Capacitor shells use `platform-mobile` permanently. Desktop Electron
 * adds `layout-compact` when the window is taller than wide, or simply too
 * narrow for the two-column dashboard — so Omarchy tiles get the mobile shell
 * without faking android/ios platform APIs.
 */

export const LAYOUT_COMPACT_CLASS = 'layout-compact'

/** Width at or below this is compact even in landscape (narrow tile). */
export const COMPACT_MAX_WIDTH_PX = 720

type Listener = (compact: boolean) => void

let compact = false
let started = false
const listeners = new Set<Listener>()

function measureCompact(
  width = typeof window !== 'undefined' ? window.innerWidth : 0,
  height = typeof window !== 'undefined' ? window.innerHeight : 0,
): boolean {
  if (width <= 0 || height <= 0) return false
  return height > width || width <= COMPACT_MAX_WIDTH_PX
}

function applyClass(next: boolean) {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle(LAYOUT_COMPACT_CLASS, next)
}

function emit() {
  for (const listener of listeners) listener(compact)
}

function sync() {
  const next = measureCompact()
  if (next === compact) {
    applyClass(next)
    return
  }
  compact = next
  applyClass(next)
  emit()
}

/** Current compact layout (portrait or narrow). Safe before start. */
export function isCompactLayout(): boolean {
  if (!started && typeof window !== 'undefined') return measureCompact()
  return compact
}

export function subscribeCompactLayout(listener: Listener): () => void {
  listeners.add(listener)
  listener(isCompactLayout())
  return () => {
    listeners.delete(listener)
  }
}

/** Install resize listeners and set the initial `layout-compact` class. */
export function startLayoutViewport(): void {
  if (started || typeof window === 'undefined') return
  started = true
  compact = measureCompact()
  applyClass(compact)

  window.addEventListener('resize', sync, { passive: true })
  // Some WMs fire orientationchange without a useful resize first.
  window.addEventListener('orientationchange', sync, { passive: true })
}

/** Test helper — reset module state between vitest cases. */
export function resetLayoutViewportForTests(): void {
  started = false
  compact = false
  listeners.clear()
  if (typeof document !== 'undefined') {
    document.documentElement.classList.remove(LAYOUT_COMPACT_CLASS)
  }
}
