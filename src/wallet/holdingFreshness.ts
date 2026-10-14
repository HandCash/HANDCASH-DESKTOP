/**
 * When local holding may be trusted without a network read (draft BRC-249,
 * "Spending" and "Checking").
 *
 * An account's holding is fresh once a check of it has run and, since then,
 * this install has kept serving the account's holding channel without a break
 * longer than {@link HOLDING_GAP_MS}. Over that time any release request would
 * have reached it, so no other install can have taken the account without it
 * knowing. A break (suspension, a throttled background timer, a reconnect, a
 * new process) is a gap: the next spend checks the account once first.
 */
import { ANSWER_WINDOW_MS } from './accountRelease'

/** Longest pause in serving the holding channel that is not a gap. */
export const HOLDING_GAP_MS = ANSWER_WINDOW_MS + 5_000

const checkedAt = new Map<string, number>()
let lastServedAt = 0
let gapAt = 0

function keyOf(identityKey: string): string {
  return identityKey.trim().toLowerCase()
}

/** A check of `identityKey` that started at `startedAt` finished (reachable or not). */
export function noteHoldingChecked(identityKey: string, startedAt: number): void {
  if (startedAt < gapAt) return
  const key = keyOf(identityKey)
  checkedAt.set(key, Math.max(checkedAt.get(key) ?? 0, startedAt))
}

/** Something this install could not have heard through: every account needs a check again. */
export function noteHoldingGap(at = Date.now()): void {
  gapAt = Math.max(gapAt, at)
}

/** The holding channel was just polled. A long pause since the last poll was a gap. */
export function noteHoldingServed(at = Date.now()): void {
  if (lastServedAt && at - lastServedAt > HOLDING_GAP_MS) noteHoldingGap(at)
  lastServedAt = at
}

export function isHoldingFresh(identityKey: string, now = Date.now()): boolean {
  const checked = checkedAt.get(keyOf(identityKey))
  if (checked == null || checked < gapAt) return false
  return lastServedAt > 0 && now - lastServedAt <= HOLDING_GAP_MS
}

export function resetHoldingFreshnessForTests(): void {
  checkedAt.clear()
  lastServedAt = 0
  gapAt = 0
}
