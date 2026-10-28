/** Console logger for shared Node host/sidecar modules (no electron-log). */
export const hostLog = {
  info: (...args: unknown[]) => console.info('[handcash]', ...args),
  warn: (...args: unknown[]) => console.warn('[handcash]', ...args),
  error: (...args: unknown[]) => console.error('[handcash]', ...args),
}
