import { assign, setup, type SnapshotFrom } from 'xstate'

/**
 * Chart: historyRecovery
 * States: probing → found → restoring.{download → validate → merge → reboot → recompose → balance}
 *                 ↘ missing            ↘ done | legacy | failure
 *                 ↘ unreachable
 *
 * Post-restore gate after keys are sealed. The remote BRC-39 is probed; when
 * present the restore starts on its own. `restoring` is a sequence of the
 * stages the wallet actually performs, reported by the domain path
 * (`replaceLocalHistoryFromCloud` → `onStage`) plus the two the panel runs
 * after it, so the progress bar is a projection of work done, not a timer.
 *
 * `legacy` is a classified failure: the blob was sealed with an older unlock
 * password; the user supplies it once and `RESTORE` runs again. `failure` is
 * any other refusal and can also be retried. Skipping is the parent's move —
 * this chart only knows about restoring.
 */
export const HISTORY_RESTORE_STAGES = [
  'download',
  'validate',
  'merge',
  'reboot',
  'recompose',
  'balance',
] as const

export type HistoryRestoreStage = (typeof HISTORY_RESTORE_STAGES)[number]

export const HISTORY_RESTORE_STAGE_LABELS: Readonly<Record<HistoryRestoreStage, string>> = {
  validate: 'Checking your backup before recovery',
  reboot: 'Reopening the wallet',
  download: 'Downloading your encrypted history',
  merge: 'Restoring history into a separate ledger',
  recompose: 'Rebuilding balances from the merged ledger',
  balance: 'Reading your balance',
}

export type HistoryRecoveryEvent =
  | { type: 'FOUND'; bytes: number | null }
  | { type: 'MISSING' }
  | { type: 'UNREACHABLE'; message: string }
  | { type: 'RESTORE' }
  | { type: 'STAGE'; stage: HistoryRestoreStage }
  | { type: 'LEGACY_NEEDED'; message: string }
  | { type: 'FAIL'; message: string }
  | { type: 'SUCCEED'; balanceSats: number }

export type HistoryRecoveryContext = {
  /** Remote blob size when the probe found one. */
  bytes: number | null
  error: string | null
  balanceSats: number | null
}

/** Shared `STAGE` routing: each stage node jumps to whichever stage the domain reports. */
const stageOn = {
  STAGE: [
    { target: 'validate', guard: 'isValidate' },
    { target: 'reboot', guard: 'isReboot' },
    { target: 'download', guard: 'isDownload' },
    { target: 'merge', guard: 'isMerge' },
    { target: 'recompose', guard: 'isRecompose' },
    { target: 'balance', guard: 'isBalance' },
  ],
  LEGACY_NEEDED: { target: '#historyRecovery.legacy', actions: 'fail' },
  FAIL: { target: '#historyRecovery.failure', actions: 'fail' },
  SUCCEED: { target: '#historyRecovery.done', actions: 'succeed' },
} as const

const isStage =
  (stage: HistoryRestoreStage) =>
  ({ event }: { event: HistoryRecoveryEvent }) =>
    event.type === 'STAGE' && event.stage === stage

export const historyRecoveryMachine = setup({
  types: {
    context: {} as HistoryRecoveryContext,
    events: {} as HistoryRecoveryEvent,
  },
  guards: {
    isValidate: isStage('validate'),
    isReboot: isStage('reboot'),
    isDownload: isStage('download'),
    isMerge: isStage('merge'),
    isRecompose: isStage('recompose'),
    isBalance: isStage('balance'),
  },
  actions: {
    found: assign(({ event }) =>
      event.type === 'FOUND' ? { bytes: event.bytes, error: null } : {}
    ),
    unreachable: assign(({ event }) =>
      event.type === 'UNREACHABLE' ? { error: event.message } : {}
    ),
    clearError: assign({ error: null }),
    fail: assign(({ event }) =>
      event.type === 'FAIL' || event.type === 'LEGACY_NEEDED' ? { error: event.message } : {}
    ),
    succeed: assign(({ event }) =>
      event.type === 'SUCCEED' ? { error: null, balanceSats: event.balanceSats } : {}
    ),
  },
}).createMachine({
  id: 'historyRecovery',
  initial: 'probing',
  context: { bytes: null, error: null, balanceSats: null },
  states: {
    /** Asking the history host whether a BRC-39 exists for this identity. */
    probing: {
      on: {
        FOUND: { target: 'found', actions: 'found' },
        MISSING: { target: 'missing' },
        UNREACHABLE: { target: 'unreachable', actions: 'unreachable' },
      },
    },
    /** A backup exists; the panel fires RESTORE without asking. */
    found: {
      on: { RESTORE: { target: 'restoring', actions: 'clearError' } },
    },
    /** Nothing to restore; the parent offers to continue with a chain scan. */
    missing: { type: 'final' },
    /** The host did not answer; the user may retry or skip. */
    unreachable: {
      on: { RESTORE: { target: 'restoring', actions: 'clearError' } },
    },
    /** One face per real stage — `STAGE` moves along them in domain order. */
    restoring: {
      initial: 'download',
      states: {
        validate: { on: stageOn },
        reboot: { on: stageOn },
        download: { on: stageOn },
        merge: { on: stageOn },
        recompose: { on: stageOn },
        balance: { on: stageOn },
      },
    },
    /** Sealed with an older unlock password — ask for it once and retry. */
    legacy: {
      on: { RESTORE: { target: 'restoring', actions: 'clearError' } },
    },
    failure: {
      on: { RESTORE: { target: 'restoring', actions: 'clearError' } },
    },
    done: { type: 'final' },
  },
})

export type HistoryRecoverySnapshot = SnapshotFrom<typeof historyRecoveryMachine>

/** Index of the active stage while restoring; stages count when done; null otherwise. */
export function historyRestoreStageIndex(snapshot: HistoryRecoverySnapshot): number | null {
  if (snapshot.matches('done')) return HISTORY_RESTORE_STAGES.length
  const value = snapshot.value
  if (typeof value !== 'object' || value === null || !('restoring' in value)) return null
  const stage = (value as { restoring: HistoryRestoreStage }).restoring
  const index = HISTORY_RESTORE_STAGES.indexOf(stage)
  return index < 0 ? null : index
}

/**
 * Bar projection: the active stage counts as half done so the bar visibly
 * moves the moment restoring begins; `done` fills it.
 */
export function historyRestoreProgress(
  snapshot: HistoryRecoverySnapshot
): { value: number; max: number } | null {
  const index = historyRestoreStageIndex(snapshot)
  if (index == null) return null
  const max = HISTORY_RESTORE_STAGES.length
  return { value: snapshot.matches('done') ? max : index + 0.5, max }
}

export type HistoryRestoreStageFace = 'done' | 'active' | 'pending'

/** Face of one stage row given the chart snapshot. */
export function historyRestoreStageFace(
  snapshot: HistoryRecoverySnapshot,
  stage: HistoryRestoreStage
): HistoryRestoreStageFace {
  const active = historyRestoreStageIndex(snapshot)
  const index = HISTORY_RESTORE_STAGES.indexOf(stage)
  if (active == null) return 'pending'
  if (index < active) return 'done'
  if (index === active) return 'active'
  return 'pending'
}
