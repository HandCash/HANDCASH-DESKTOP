/**
 * Crash-loop breaker for BRC-39 auto-backup.
 *
 * A backup that kills the app is uniquely nasty: the run never records success,
 * so the next launch sees the same "never uploaded" state and tries again, dies
 * again, forever. The user's only symptom is an app that will not stay open.
 *
 * The guard is a durable "attempt open" marker written *before* the heavy work.
 * Finding one at boot means the previous attempt did not return — a crash, a
 * kill, or a force-quit — so the next attempt is delayed, and the delay grows
 * with each consecutive failure. A success clears the streak.
 *
 * Backoff is deliberately conservative. Losing a few hours of backup freshness
 * is recoverable; an app that cannot be opened is not.
 *
 * The one thing that always clears a streak is an upgrade: the failures were
 * recorded by code the user is no longer running, and holding a fixed build
 * hostage to the broken one's history is how a twelve-hour lockout outlives the
 * bug that earned it.
 */
import { APP_VERSION } from '../version'
import { durableGetItem, durableSetItem } from './durableStorage'

const KEY = 'handcash.cloudBackup.watchdog.v1'

/** Delay after 1, 2, 3… consecutive failed attempts. Last value repeats. */
const BACKOFF_MS = [
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  12 * 60 * 60_000,
  24 * 60 * 60_000,
]

type WatchdogState = {
  /** Set while an attempt is in flight; a surviving value means it never returned. */
  openedAt: number | null
  consecutiveFailures: number
  lastSuccessAt: number | null
  blockedUntil: number | null
  /** App version that recorded the current streak. */
  failedOnVersion: string | null
}

const EMPTY: WatchdogState = {
  openedAt: null,
  consecutiveFailures: 0,
  lastSuccessAt: null,
  blockedUntil: null,
  failedOnVersion: null,
}

function read(): WatchdogState {
  try {
    const raw = durableGetItem(KEY)
    if (!raw) return { ...EMPTY }
    const parsed = JSON.parse(raw) as Partial<WatchdogState>
    return {
      openedAt: typeof parsed.openedAt === 'number' ? parsed.openedAt : null,
      consecutiveFailures:
        typeof parsed.consecutiveFailures === 'number' ? parsed.consecutiveFailures : 0,
      lastSuccessAt:
        typeof parsed.lastSuccessAt === 'number' ? parsed.lastSuccessAt : null,
      blockedUntil: typeof parsed.blockedUntil === 'number' ? parsed.blockedUntil : null,
      failedOnVersion:
        typeof parsed.failedOnVersion === 'string' ? parsed.failedOnVersion : null,
    }
  } catch {
    return { ...EMPTY }
  }
}

function write(state: WatchdogState): void {
  try {
    durableSetItem(KEY, JSON.stringify(state))
  } catch {
    // A wallet that cannot persist the guard must still be usable.
  }
}

function backoffFor(failures: number): number {
  const idx = Math.min(Math.max(failures, 1), BACKOFF_MS.length) - 1
  return BACKOFF_MS[idx]
}

/**
 * Convert an attempt that never returned into a recorded failure.
 *
 * Call once at boot, before anything schedules a backup.
 * Returns the crash message to log, or null when the last run was clean.
 */
export function reconcileBackupWatchdog(now = Date.now()): string | null {
  const state = read()

  // An upgrade is the strongest evidence we get that the cause was addressed.
  if (
    state.failedOnVersion != null &&
    state.failedOnVersion !== APP_VERSION &&
    (state.consecutiveFailures > 0 || state.blockedUntil != null)
  ) {
    write({
      openedAt: null,
      consecutiveFailures: 0,
      lastSuccessAt: state.lastSuccessAt,
      blockedUntil: null,
      failedOnVersion: null,
    })
    return `cleared BRC-39 backup backoff from v${state.failedOnVersion} — now on v${APP_VERSION}`
  }

  if (state.openedAt == null) return null

  const failures = state.consecutiveFailures + 1
  const wait = backoffFor(failures)
  write({
    openedAt: null,
    consecutiveFailures: failures,
    lastSuccessAt: state.lastSuccessAt,
    blockedUntil: now + wait,
    failedOnVersion: APP_VERSION,
  })
  return `previous BRC-39 backup never finished (attempt ${failures}) — holding off ${Math.round(
    wait / 60_000,
  )}m`
}

/** Reason the backup must not run now, or null when it may proceed. */
export function backupBlockedReason(now = Date.now()): string | null {
  const state = read()
  if (state.openedAt != null) return 'a backup attempt is already open'
  if (state.blockedUntil != null && now < state.blockedUntil) {
    const mins = Math.max(1, Math.round((state.blockedUntil - now) / 60_000))
    return `backing off after ${state.consecutiveFailures} failed attempt(s) — ${mins}m left`
  }
  return null
}

/** Mark an attempt open. Must be durable before the expensive work begins. */
export function openBackupAttempt(now = Date.now()): void {
  const state = read()
  write({ ...state, openedAt: now })
}

export function closeBackupAttempt(ok: boolean, now = Date.now()): void {
  const state = read()
  if (ok) {
    write({
      openedAt: null,
      consecutiveFailures: 0,
      lastSuccessAt: now,
      blockedUntil: null,
      failedOnVersion: null,
    })
    return
  }
  const failures = state.consecutiveFailures + 1
  write({
    openedAt: null,
    consecutiveFailures: failures,
    lastSuccessAt: state.lastSuccessAt,
    blockedUntil: now + backoffFor(failures),
    failedOnVersion: APP_VERSION,
  })
}

/** Settings "Back up now" clears the streak so a manual retry is never blocked. */
export function clearBackupBackoff(): void {
  const state = read()
  write({
    ...state,
    openedAt: null,
    consecutiveFailures: 0,
    blockedUntil: null,
    failedOnVersion: null,
  })
}

export function getBackupWatchdogState(): WatchdogState {
  return read()
}
