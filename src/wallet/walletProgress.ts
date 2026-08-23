/**
 * Shared wallet progress bus — Refresh / 1sat import / phrase import honesty.
 *
 * Soft Syncing UI may clear early (send comfort / watchdog), but this bus stays
 * `running` until chain ingest or the active import actually finishes. Activity
 * and the status pill bind here so balance chrome never looks fully idle while
 * collectables are still landing.
 *
 * Pattern matches `paymentProgress.ts` / `verificationProgress.ts`.
 */

export type WalletProgressKind =
  | 'refresh'
  | 'phrase-import'
  | 'one-sat-import'

export type WalletProgressStatus =
  | 'idle'
  | 'running'
  | 'done'
  | 'failed'
  | 'needs-resume'

export type WalletProgress = {
  kind: WalletProgressKind | null
  /** Short machine phase: scanning | importing-items | catching-up | … */
  phase: string | null
  current: number | null
  total: number | null
  failed: number
  skipped: number
  status: WalletProgressStatus
  message: string | null
  updatedAt: number
}

type Listener = (progress: WalletProgress) => void

const listeners = new Set<Listener>()

const IDLE: WalletProgress = {
  kind: null,
  phase: null,
  current: null,
  total: null,
  failed: 0,
  skipped: 0,
  status: 'idle',
  message: null,
  updatedAt: 0,
}

let progress: WalletProgress = { ...IDLE }
let clearTimer: ReturnType<typeof setTimeout> | null = null

function emit(): void {
  for (const listener of listeners) listener(progress)
}

function clearClearTimer(): void {
  if (clearTimer) {
    clearTimeout(clearTimer)
    clearTimer = null
  }
}

export function getWalletProgress(): WalletProgress {
  return progress
}

export function isWalletProgressBusy(
  snapshot: WalletProgress = progress,
): boolean {
  return snapshot.status === 'running'
}

/** Activity feed no longer hosts wallet progress — phrase sweep panel only. */
export function showsActivityWalletProgress(
  _snapshot: WalletProgress = progress,
): boolean {
  return false
}

export function walletProgressPercent(
  snapshot: WalletProgress = progress,
): number | null {
  const total = snapshot.total
  const current = snapshot.current
  if (total == null || total <= 0 || current == null) return null
  return Math.max(0, Math.min(100, Math.round((current / total) * 100)))
}

/** Short pill / Activity title. */
export function walletProgressLabel(
  snapshot: WalletProgress = progress,
): string {
  if (snapshot.status === 'failed') return 'Sweep failed'
  if (snapshot.status === 'done') return 'Sweep complete'
  if (snapshot.status === 'needs-resume') return 'Sweep paused'
  // Soft-deadline honesty wins over import kind so pill/subtitle stay Catching up.
  if (snapshot.phase === 'catching-up' && snapshot.status === 'running') {
    return 'Catching up'
  }
  if (snapshot.kind === 'phrase-import') return 'Sweeping'
  if (snapshot.kind === 'one-sat-import') return 'Importing'
  if (snapshot.kind === 'refresh') {
    if (snapshot.phase === 'importing-items') return 'Importing'
    return 'Syncing'
  }
  return 'Working'
}

/** Subtitle / tooltip line. */
export function walletProgressDetail(
  snapshot: WalletProgress = progress,
): string | null {
  if (snapshot.message?.trim()) return snapshot.message.trim()
  const parts: string[] = []
  if (snapshot.current != null && snapshot.total != null && snapshot.total > 0) {
    parts.push(
      `${snapshot.current.toLocaleString()} of ${snapshot.total.toLocaleString()}`,
    )
  } else if (snapshot.current != null) {
    parts.push(`${snapshot.current.toLocaleString()} imported`)
  }
  if (snapshot.failed > 0) {
    parts.push(`${snapshot.failed.toLocaleString()} failed`)
  }
  if (snapshot.skipped > 0) {
    parts.push(`${snapshot.skipped.toLocaleString()} skipped`)
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

export function startWalletProgress(args: {
  kind: WalletProgressKind
  phase?: string | null
  current?: number | null
  total?: number | null
  failed?: number
  skipped?: number
  message?: string | null
}): void {
  clearClearTimer()
  progress = {
    kind: args.kind,
    phase: args.phase ?? null,
    current: args.current ?? null,
    total: args.total ?? null,
    failed: Math.max(0, Math.trunc(args.failed ?? 0)),
    skipped: Math.max(0, Math.trunc(args.skipped ?? 0)),
    status: 'running',
    message: args.message?.trim() || null,
    updatedAt: Date.now(),
  }
  emit()
}

export function updateWalletProgress(
  patch: Partial<
    Pick<
      WalletProgress,
      | 'kind'
      | 'phase'
      | 'current'
      | 'total'
      | 'failed'
      | 'skipped'
      | 'message'
      | 'status'
    >
  >,
): void {
  if (progress.status !== 'running' && progress.status !== 'needs-resume') {
    return
  }
  clearClearTimer()
  progress = {
    ...progress,
    ...patch,
    failed:
      patch.failed != null
        ? Math.max(0, Math.trunc(patch.failed))
        : progress.failed,
    skipped:
      patch.skipped != null
        ? Math.max(0, Math.trunc(patch.skipped))
        : progress.skipped,
    message:
      patch.message !== undefined
        ? patch.message?.trim() || null
        : progress.message,
    status: patch.status ?? progress.status,
    updatedAt: Date.now(),
  }
  emit()
}

/**
 * Terminal transition. `done` / `failed` auto-clear after a short paint window
 * so Activity can show a completed bar then drop the live row.
 */
export function finishWalletProgress(
  status: Exclude<WalletProgressStatus, 'idle' | 'running'>,
  patch?: Partial<
    Pick<WalletProgress, 'phase' | 'current' | 'total' | 'failed' | 'skipped' | 'message'>
  >,
): void {
  if (progress.status === 'idle') return
  clearClearTimer()
  progress = {
    ...progress,
    ...patch,
    failed:
      patch?.failed != null
        ? Math.max(0, Math.trunc(patch.failed))
        : progress.failed,
    skipped:
      patch?.skipped != null
        ? Math.max(0, Math.trunc(patch.skipped))
        : progress.skipped,
    message:
      patch?.message !== undefined
        ? patch.message?.trim() || null
        : progress.message,
    status,
    updatedAt: Date.now(),
  }
  emit()
  if (status === 'done' || status === 'failed') {
    clearTimer = setTimeout(() => {
      clearTimer = null
      if (progress.status === status) clearWalletProgress()
    }, 2_400)
  }
}

export function clearWalletProgress(): void {
  clearClearTimer()
  progress = { ...IDLE, updatedAt: Date.now() }
  emit()
}

export function subscribeWalletProgress(listener: Listener): () => void {
  listeners.add(listener)
  listener(progress)
  return () => {
    listeners.delete(listener)
  }
}

/** Test helper — drop in-memory progress between cases. */
export function resetWalletProgressForTests(): void {
  clearClearTimer()
  progress = { ...IDLE }
}
