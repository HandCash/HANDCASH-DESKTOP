/**
 * Live authenticity / identity work for a single collectable.
 *
 * The details panel reads this so an unverified tip does not look abandoned
 * while a lineage walk or indexer fill is actually running for it.
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

/** True when this tip is the one currently being verified or identified. */
export function isOutpointVerifying(
  outpoint: string | null | undefined,
  current: VerificationProgress = progress,
): boolean {
  if (!outpoint || current.phase === 'idle' || !current.outpoint) return false
  return normalize(outpoint) === current.outpoint
}
