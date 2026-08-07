/**
 * Live authenticity work for collectables.
 *
 * A tip enters `awaiting` as soon as it is received (toast), and stays there
 * until authenticity settles — that drives the corner spinner. Separately,
 * `progress` names which tip is actively being walked right now.
 */

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
const awaitingVerify = new Set<string>()

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
  if (op) awaitingVerify.add(op)
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
  awaitingVerify.add(key)
  // New object so React subscribers re-render and pick up isOutpointVerifying.
  progress = { ...progress }
  emit()
}

/** Tip authenticity settled — drop the spinner for this outpoint. */
export function clearAwaitingVerification(outpoint: string): void {
  const key = normalize(outpoint)
  if (!key || !awaitingVerify.has(key)) return
  awaitingVerify.delete(key)
  if (progress.outpoint === key) {
    progress = { outpoint: null, phase: 'idle', label: null, detail: null }
  } else {
    progress = { ...progress }
  }
  emit()
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
 * True while this tip is waiting on authenticity or is the active walk target.
 * Used by the corner spinner — must stay true from receive until verified.
 */
export function isOutpointVerifying(
  outpoint: string | null | undefined,
  current: VerificationProgress = progress,
): boolean {
  if (!outpoint) return false
  const key = normalize(outpoint)
  if (awaitingVerify.has(key)) return true
  if (current.phase === 'idle' || !current.outpoint) return false
  return key === current.outpoint
}
