/**
 * Live authenticity work for collectables.
 *
 * A tip enters `awaiting` as soon as it is received (toast), and stays there
 * until authenticity settles — that drives the corner spinner. Separately,
 * `progress` names which tip is actively being walked right now.
 *
 * Important: marking progress as verifying/identifying must NOT put a tip into
 * `awaiting`. That set is only for "received, not yet settled". Conflating the
 * two left tips stuck on Verifying forever after an aborted lineage walk.
 */
import { isItemProven } from './provenCache'

export type VerificationPhase = 'idle' | 'verifying' | 'identifying'

export type VerificationProgress = {
  outpoint: string | null
  phase: VerificationPhase
  label: string | null
  detail: string | null
}

type Listener = (progress: VerificationProgress) => void

const listeners = new Set<Listener>()

/** Tips received but not yet authenticity-proven — spinner stays until cleared. */
const awaitingVerify = new Map<string, number>()

/**
 * How long a receive may keep the corner spinner without a conclusive prove.
 * After this we drop to Unverified so a budget miss / aborted walk cannot leave
 * "Verifying…" forever while the card already shows name and traits.
 */
export const AWAITING_VERIFY_MAX_MS = 90_000

let progress: VerificationProgress = {
  outpoint: null,
  phase: 'idle',
  label: null,
  detail: null,
}

/** Tip the details panel wants proven next — jumps the genesis queue. */
let preferredOutpoint: string | null = null

function normalize(outpoint: string): string {
  return outpoint.trim().toLowerCase().replace(/_(\d+)$/, '.$1')
}

function emit(): void {
  for (const listener of listeners) listener(progress)
}

export function getVerificationProgress(): VerificationProgress {
  return progress
}

export function setVerificationProgress(
  phase: VerificationPhase,
  outpoint?: string | null,
  detail?: string | null,
): void {
  if (phase === 'idle') {
    progress = { outpoint: null, phase: 'idle', label: null, detail: null }
    emit()
    return
  }
  const op = outpoint ? normalize(outpoint) : null
  progress = {
    outpoint: op,
    phase,
    label: phase === 'verifying' ? 'Verifying…' : 'Identifying…',
    detail:
      detail?.trim() ||
      (phase === 'verifying'
        ? 'Proving tip-to-origin lineage (BRC-150)'
        : 'Fetching name and traits from the indexer'),
  }
  emit()
}

export function clearVerificationProgress(outpoint?: string | null): void {
  if (
    outpoint &&
    progress.outpoint &&
    normalize(outpoint) !== progress.outpoint
  ) {
    return
  }
  setVerificationProgress('idle')
}

/**
 * Mark a freshly received tip as verifying so the corner spinner appears
 * immediately — before the lineage walk is scheduled.
 */
export function noteAwaitingVerification(outpoint: string): void {
  const key = normalize(outpoint)
  if (!key || awaitingVerify.has(key)) return
  if (isItemProven(key)) return
  awaitingVerify.set(key, Date.now())
  // New object so React subscribers re-render and pick up isOutpointVerifying.
  progress = { ...progress }
  emit()
}

/** Tip authenticity settled — drop the spinner for this outpoint. */
export function clearAwaitingVerification(outpoint: string): void {
  const key = normalize(outpoint)
  if (!key) return
  const had = awaitingVerify.delete(key)
  const wasActive = progress.outpoint === key
  if (!had && !wasActive) return
  if (wasActive) {
    progress = { outpoint: null, phase: 'idle', label: null, detail: null }
  } else {
    progress = { ...progress }
  }
  emit()
}

/**
 * Drop awaiting tips that will not be proven this pass (budget / cooldown /
 * no candidates). Call after proveHeldGenesis early-returns or finishes so
 * Collect cannot spin forever on Unverified items that already have metadata.
 */
export function settleStaleAwaitingVerification(
  stillPending: (outpoint: string) => boolean = () => false,
): void {
  let changed = false
  for (const key of [...awaitingVerify.keys()]) {
    if (isItemProven(key) || !stillPending(key)) {
      awaitingVerify.delete(key)
      changed = true
      if (progress.outpoint === key) {
        progress = { outpoint: null, phase: 'idle', label: null, detail: null }
      }
    }
  }
  if (changed) {
    progress = { ...progress }
    emit()
  }
}

export function listAwaitingVerification(): string[] {
  return [...awaitingVerify.keys()]
}

export function subscribeVerificationProgress(listener: Listener): () => void {
  listeners.add(listener)
  listener(progress)
  return () => {
    listeners.delete(listener)
  }
}

/** Prefer this tip the next time a lineage walk runs. */
export function preferCollectableVerification(outpoint: string): void {
  preferredOutpoint = normalize(outpoint)
}

export function takePreferredCollectableVerification(): string | null {
  const next = preferredOutpoint
  preferredOutpoint = null
  return next
}

export function peekPreferredCollectableVerification(): string | null {
  return preferredOutpoint
}

/**
 * True while this tip is waiting on authenticity or is the active *verify*
 * walk. Indexer `identifying` must not drive the corner spinner — Collect
 * remounts re-run identify/upgrade and that looked like a fresh verification.
 */
export function isOutpointVerifying(
  outpoint: string | null | undefined,
  current: VerificationProgress = progress,
  now = Date.now(),
): boolean {
  if (!outpoint) return false
  const key = normalize(outpoint)
  // Self-heal: a durable proven tip must never keep a stale awaiting spinner.
  if (isItemProven(key)) {
    if (awaitingVerify.has(key) || current.outpoint === key) {
      clearAwaitingVerification(key)
    }
    return false
  }
  const since = awaitingVerify.get(key)
  if (since != null) {
    if (now - since > AWAITING_VERIFY_MAX_MS) {
      clearAwaitingVerification(key)
      return current.phase === 'verifying' && current.outpoint === key
    }
    return true
  }
  if (current.phase !== 'verifying' || !current.outpoint) return false
  return key === current.outpoint
}

/** Test helper — drop in-memory verify state between cases. */
export function resetVerificationProgressForTests(): void {
  awaitingVerify.clear()
  preferredOutpoint = null
  progress = { outpoint: null, phase: 'idle', label: null, detail: null }
}
