/**
 * Isolated empty-local × remote-BRC-39 edge case.
 *
 * When localState looks empty (wrong IDB origin, wiped IDB, fresh unlock) and a
 * non-empty remote historyReplica exists, auto paths must:
 *   1. pull (if allowed), never
 *   2. PUT an empty blob over the remote
 *
 * Manual History → Upload may still overwrite (operator intent).
 * Post-spend pushes are safe because spent wallets still have actions/outs metadata
 * so `localToolboxStateLooksEmpty()` is false.
 *
 * Keep this module free of UI / chainIngest imports — historyReplica only.
 */

/** Remote blobs smaller than this are treated as empty stubs (safe to replace). */
export const MIN_REMOTE_BYTES_TO_PROTECT = 256

export type EmptyOverwriteDecision = {
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

/** Reasons that may pull remote into an empty localState. */
export function allowEmptyLocalHistoryPull(reason: string): boolean {
  return (
    reason === 'unlock' ||
    reason === 'create' ||
    reason === 'recompose' ||
    reason === 'restore-url' ||
    reason === 'import-file' ||
    reason === 'pair-sync'
  )
}
