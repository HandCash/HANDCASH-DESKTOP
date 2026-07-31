/**
 * BRC-114 — Time labels for listActions filters.
 * @see https://bsv.brc.dev/wallet/0114.md
 *
 * Wallet Toolbox already parses these control labels. Helpers build / peel them
 * for bridge callers and UI windows (24h / 7d / 30d).
 */

export type ActionTimeBounds = {
  /** Inclusive lower bound (unix ms). */
  fromMs?: number
  /** Exclusive upper bound (unix ms). */
  toMs?: number
}

const FROM_PREFIX = 'action time from '
const TO_PREFIX = 'action time to '
const RESPONSE_PREFIX = 'action time '

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

export function parseActionTimeBounds(labels: string[]): ActionTimeBounds {
  let fromMs: number | undefined
  let toMs: number | undefined
  for (const label of labels) {
    if (label.startsWith(FROM_PREFIX)) {
      const v = label.slice(FROM_PREFIX.length)
      if (!/^\d+$/.test(v)) throw new Error('Invalid action time from label')
      fromMs = Number.parseInt(v, 10)
    } else if (label.startsWith(TO_PREFIX)) {
      const v = label.slice(TO_PREFIX.length)
      if (!/^\d+$/.test(v)) throw new Error('Invalid action time to label')
      toMs = Number.parseInt(v, 10)
    }
  }
  if (fromMs != null && toMs != null && fromMs >= toMs) {
    throw new Error('action time from must be less than action time to')
  }
  return { fromMs, toMs }
}

/** Strip BRC-114 control labels; keep ordinary labels (and response `action time <ms>`). */
export function withoutActionTimeControlLabels(labels: string[]): string[] {
  return labels.filter(
    (l) => !l.startsWith(FROM_PREFIX) && !l.startsWith(TO_PREFIX),
  )
}

export function isActionTimeResponseLabel(label: string): boolean {
  if (!label.startsWith(RESPONSE_PREFIX)) return false
  if (label.startsWith(FROM_PREFIX) || label.startsWith(TO_PREFIX)) return false
  return /^\d+$/.test(label.slice(RESPONSE_PREFIX.length))
}
