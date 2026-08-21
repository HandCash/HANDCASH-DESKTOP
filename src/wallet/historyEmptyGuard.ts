/**
 * Isolated empty-local × remote-BRC-39 edge case + thin-overwrite guard.
 *
 * When localState looks empty (wrong IDB origin, wiped IDB, fresh unlock) and a
 * non-empty remote historyReplica exists, auto paths must:
 *   1. pull (if allowed), never
 *   2. PUT an empty blob over the remote
 *
 * Thin overwrite: a UTXO leaves managed spendable only when spent. Auto push must
 * not PUT a lower spendable over a richer remote / high-water unless local action
 * count proves new spends (actions go up when coins are dispensed).
 *
 * Manual History → Upload may still overwrite (operator intent, force: true).
 * Post-spend pushes are safe because spent wallets still have actions/outs metadata
 * so `localToolboxStateLooksEmpty()` is false, and actionCount rises.
 *
 * Keep this module free of UI / chainIngest imports — historyReplica only.
 */

/** Remote blobs smaller than this are treated as empty stubs (safe to replace). */
export const MIN_REMOTE_BYTES_TO_PROTECT = 256

/**
 * Allow tiny balance drift (fees / rounding) before treating local as thinner.
 * Not a license to drop managed UTXOs — only noise margin for comparisons.
 */
export const SPENDABLE_COMPARE_MARGIN_SATS = 2_000

export type EmptyOverwriteDecision = {
  refusePush: boolean
  reason: string | null
}

export type ThinOverwriteDecision = {
  refusePush: boolean
  reason: string | null
}

/**
 * True when auto-sync must not PUT local over remote.
 * Isolated predicate — unit-test this without booting Electron.
 */
export function decideEmptyHistoryOverwrite(args: {
  remoteExists: boolean
  remoteBytes: number | null
  localLooksEmpty: boolean
  /** Explicit Settings upload — operator confirms overwrite. */
  force?: boolean
}): EmptyOverwriteDecision {
  if (args.force) {
    return { refusePush: false, reason: null }
  }
  if (!args.localLooksEmpty) {
    return { refusePush: false, reason: null }
  }
  const remoteProtected =
    args.remoteExists &&
    (args.remoteBytes == null || args.remoteBytes >= MIN_REMOTE_BYTES_TO_PROTECT)
  if (!remoteProtected) {
    return { refusePush: false, reason: null }
  }
  return {
    refusePush: true,
    reason: 'refuse empty localState overwrite of remote BRC-39',
  }
}

/**
 * Refuse auto-push when local managed spendable is thinner than a known richer
 * baseline, unless actionCount proves coins were spent (dispensed).
 *
 * Baselines: remote BRC-39 headers and/or durable local high-water.
 */
export function decideThinHistoryOverwrite(args: {
  localSpendableSats: number
  localActionCount: number
  remoteSpendableSats: number | null
  remoteActionCount: number | null
  highWaterSpendableSats: number | null
  highWaterActionCount: number | null
  force?: boolean
  marginSats?: number
}): ThinOverwriteDecision {
  if (args.force) {
    return { refusePush: false, reason: null }
  }

  const margin = args.marginSats ?? SPENDABLE_COMPARE_MARGIN_SATS
  const localSats = Math.max(0, Math.trunc(args.localSpendableSats))
  const localActions = Math.max(0, Math.trunc(args.localActionCount))

  const against = (
    baselineSats: number | null,
    baselineActions: number | null,
    label: string,
  ): ThinOverwriteDecision | null => {
    if (baselineSats == null || !Number.isFinite(baselineSats)) return null
    const rich = Math.max(0, Math.trunc(baselineSats))
    if (localSats + margin >= rich) return null
    const priorActions =
      baselineActions != null && Number.isFinite(baselineActions)
        ? Math.max(0, Math.trunc(baselineActions))
        : null
    // Spent down: toolbox records more actions when UTXOs are dispensed.
    if (priorActions != null && localActions > priorActions) return null
    return {
      refusePush: true,
      reason: `refuse thin local overwrite of ${label} (local ${localSats} sats / ${localActions} actions vs ${rich} sats / ${priorActions ?? '?'} actions)`,
    }
  }

  const vsRemote = against(
    args.remoteSpendableSats,
    args.remoteActionCount,
    'richer remote BRC-39',
  )
  if (vsRemote) return vsRemote

  const vsHigh = against(
    args.highWaterSpendableSats,
    args.highWaterActionCount,
    'spendable high-water',
  )
  if (vsHigh) return vsHigh

  return { refusePush: false, reason: null }
}

/** Empty-local + thin-overwrite in one fail-closed decision. */
export function decideHistoryPush(args: {
  remoteExists: boolean
  remoteBytes: number | null
  localLooksEmpty: boolean
  localSpendableSats: number
  localActionCount: number
  remoteSpendableSats: number | null
  remoteActionCount: number | null
  highWaterSpendableSats: number | null
  highWaterActionCount: number | null
  force?: boolean
}): EmptyOverwriteDecision {
  const empty = decideEmptyHistoryOverwrite({
    remoteExists: args.remoteExists,
    remoteBytes: args.remoteBytes,
    localLooksEmpty: args.localLooksEmpty,
    force: args.force,
  })
  if (empty.refusePush) return empty

  // A pre-metadata BRC-39 blob is still a recovery copy. Without both balance
  // and action headers we cannot prove a thinner local wallet represents real
  // spends rather than a partial restore, so auto paths must preserve it.
  const protectedRemote =
    args.remoteExists &&
    (args.remoteBytes == null || args.remoteBytes >= MIN_REMOTE_BYTES_TO_PROTECT)
  if (
    !args.force &&
    protectedRemote &&
    (args.remoteSpendableSats == null || args.remoteActionCount == null)
  ) {
    return {
      refusePush: true,
      reason: 'refuse overwrite of remote BRC-39 with incomplete richness metadata',
    }
  }

  return decideThinHistoryOverwrite({
    localSpendableSats: args.localSpendableSats,
    localActionCount: args.localActionCount,
    remoteSpendableSats: args.remoteSpendableSats,
    remoteActionCount: args.remoteActionCount,
    highWaterSpendableSats: args.highWaterSpendableSats,
    highWaterActionCount: args.highWaterActionCount,
    force: args.force,
  })
}

/** Reasons that may pull remote into an empty localState. */
export function allowEmptyLocalHistoryPull(reason: string): boolean {
  return (
    reason === 'unlock' ||
    reason === 'create' ||
    reason === 'restore' ||
    reason === 'recompose' ||
    reason === 'restore-url' ||
    reason === 'import-file' ||
    reason === 'pair-sync'
  )
}
