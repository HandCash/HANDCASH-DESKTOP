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
