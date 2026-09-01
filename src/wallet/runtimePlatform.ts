/**
 * Thin platform helpers shared by unlock / sync scheduling.
 *
 * Phone shells need longer deferrals around unlock (WebView OOM / ANR risk).
 * Desktop Electron can start the same work immediately — same code path, less wait.
 */

export function isPhoneShell(): boolean {
  const p = typeof window !== 'undefined' ? window.handcash?.platform : undefined
  return p === 'android' || p === 'ios'
}

/** Vite dev in a plain browser — no Electron/Capacitor bridge; direct explorer APIs hit CORS. */
export function isViteDevBrowser(): boolean {
  if (typeof window === 'undefined' || !import.meta.env.DEV) return false
  return window.handcash == null
}
