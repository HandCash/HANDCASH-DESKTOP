/**
 * BRC-114 — Time labels for listActions filters.
 * @see https://bsv.brc.dev/wallet/0114.md
 *
 * Wallet Toolbox already parses these control labels. Helpers build them
 * for bridge callers and UI windows (24h / 7d / 30d).
 */

const FROM_PREFIX = 'action time from '
const TO_PREFIX = 'action time to '

export function actionTimeFromLabel(fromMs: number): string {
  if (!Number.isInteger(fromMs) || fromMs < 0) {
    throw new Error('action time from must be a non-negative integer unix ms')
  }
  return `${FROM_PREFIX}${fromMs}`
}

export function actionTimeToLabel(toMs: number): string {
  if (!Number.isInteger(toMs) || toMs < 0) {
    throw new Error('action time to must be a non-negative integer unix ms')
  }
  return `${TO_PREFIX}${toMs}`
}

/** Build BRC-114 control labels for a window ending at `now` (default Date.now()). */
export function actionTimeLabelsForWindow(
  windowMs: number,
  now = Date.now(),
): string[] {
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error('Window must be a positive duration in ms')
  }
  const toMs = Math.trunc(now) + 1
  const fromMs = Math.max(0, toMs - Math.trunc(windowMs))
  return [actionTimeFromLabel(fromMs), actionTimeToLabel(toMs)]
}
