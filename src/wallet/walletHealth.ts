/**
 * User-visible **chainIngest** health — review/import outcomes + held 1-sats / unlock nudges.
 * History replica health lives in `cloudBackupHealth.ts`. See `layers.ts`.
 *
 * Soft in-flight sync does not invent a long pill label — the status bubble stays
 * on a short "Syncing…" while details live in `message` (tooltip).
 *
 * Status is stamped with the active vault account identity. Switching accounts
 * rebinds + resets so root's "Synced" cannot paint onto an unsynced child.
 */

export type SyncHealth = {
  phase: 'idle' | 'syncing' | 'ok' | 'error'
  /** Longer user-facing line; null when quiet. */
  message: string | null
  heldOneSats: number
  /** Held tips known to be items, still awaiting an origin. */
  pendingTips: number
  updatedAt: number
  /** Vault account this status belongs to (null before unlock / after lock). */
  identityKey: string | null
  /** BRC-146 account index for the stamped identity. */
  accountIndex: number | null
}

type SyncListener = (health: SyncHealth) => void
type UnlockListener = (needed: boolean) => void

const syncListeners = new Set<SyncListener>()
const unlockListeners = new Set<UnlockListener>()

let boundIdentityKey: string | null = null
let boundAccountIndex: number | null = null
const syncHealthByIdentity = new Map<string, SyncHealth>()

let syncHealth: SyncHealth = {
  phase: 'idle',
  message: null,
  heldOneSats: 0,
  pendingTips: 0,
  updatedAt: 0,
  identityKey: null,
  accountIndex: null,
}

let unlockNeeded = false
let unlockClearTimer: ReturnType<typeof setTimeout> | null = null
/** Force-clear a hung syncing pill so the UI cannot sit on Syncing forever. */
let syncingWatchdog: ReturnType<typeof setTimeout> | null = null
const SYNCING_WATCHDOG_MS = 45_000

function emitSync() {
  for (const l of syncListeners) l(syncHealth)
}

function emitUnlock() {
  for (const l of unlockListeners) l(unlockNeeded)
}

function clearSyncingWatchdog(): void {
  if (syncingWatchdog) {
    clearTimeout(syncingWatchdog)
    syncingWatchdog = null
  }
}

function armSyncingWatchdog(): void {
  clearSyncingWatchdog()
  syncingWatchdog = setTimeout(() => {
    syncingWatchdog = null
    if (syncHealth.phase !== 'syncing') return
    console.warn(
      '[sync-health] syncing watchdog fired — clearing stuck Syncing pill',
      syncHealth.message,
    )
    try {
      void import('./appLog').then(({ appendAppLog }) => {
        appendAppLog(
          'warn',
          `[sync-health] syncing watchdog fired — ${syncHealth.message ?? 'no message'}`,
        )
      })
    } catch {
      /* ignore */
    }
    // Never claim a clean Synced while chain ingest may still hold the spend
    // lock — that is how sends time out with a green "Synced" pill. Keep a
    // catching-up message so the status bubble stays honest.
    void import('./walletCoordinator')
      .then(({ getWalletCoordinatorSnapshot }) => {
        const ingestBusy =
          getWalletCoordinatorSnapshot().chainIngest === 'active'
        setSyncHealth({
          phase: 'ok',
          message: ingestBusy
            ? 'Still importing in the background…'
            : null,
        })
      })
      .catch(() => {
        setSyncHealth({
          phase: 'ok',
          message: 'Still importing in the background…',
        })
      })
  }, SYNCING_WATCHDOG_MS)
}

/**
 * Bind sync status to the active vault account. Resets the pill so a prior
 * account's Synced/Syncing state cannot leak onto the next identity.
 */
export function bindSyncHealthAccount(
  args: { identityKey: string; accountIndex: number } | null,
): void {
  clearSyncingWatchdog()
  if (boundIdentityKey) {
    syncHealthByIdentity.set(boundIdentityKey, syncHealth)
  }
  if (!args) {
    boundIdentityKey = null
    boundAccountIndex = null
    syncHealth = {
      phase: 'idle',
      message: null,
      heldOneSats: 0,
      pendingTips: 0,
      updatedAt: Date.now(),
      identityKey: null,
      accountIndex: null,
    }
    emitSync()
    return
  }
  boundIdentityKey = args.identityKey
  boundAccountIndex = args.accountIndex
  syncHealth =
    syncHealthByIdentity.get(args.identityKey) ?? {
      phase: 'idle',
      message: null,
      heldOneSats: 0,
      pendingTips: 0,
      updatedAt: Date.now(),
      identityKey: args.identityKey,
      accountIndex: args.accountIndex,
    }
  syncHealthByIdentity.set(args.identityKey, syncHealth)
  if (syncHealth.phase === 'syncing') armSyncingWatchdog()
  emitSync()
}

export function getBoundSyncHealthIdentity(): {
  identityKey: string | null
  accountIndex: number | null
} {
  return { identityKey: boundIdentityKey, accountIndex: boundAccountIndex }
}

export function getSyncHealth(): SyncHealth {
  return syncHealth
}

/**
 * Apply a sync-health patch for the active account.
 * Patches stamped with a different identityKey (abandoned ingest after switch)
 * are dropped so root cannot paint Synced onto a child.
 */
export function setSyncHealth(patch: Partial<SyncHealth>): void {
  const targetIdentity = patch.identityKey ?? boundIdentityKey
  if (targetIdentity && targetIdentity !== boundIdentityKey) {
    const previous =
      syncHealthByIdentity.get(targetIdentity) ?? {
        phase: 'idle',
        message: null,
        heldOneSats: 0,
        pendingTips: 0,
        updatedAt: 0,
        identityKey: targetIdentity,
        accountIndex: patch.accountIndex ?? null,
      }
    syncHealthByIdentity.set(targetIdentity, {
      ...previous,
      ...patch,
      identityKey: targetIdentity,
      updatedAt: Date.now(),
    })
    return
  }
  syncHealth = {
    ...syncHealth,
    ...patch,
    identityKey: boundIdentityKey ?? patch.identityKey ?? syncHealth.identityKey,
    accountIndex:
      boundAccountIndex ?? patch.accountIndex ?? syncHealth.accountIndex,
    updatedAt: Date.now(),
  }
  if (syncHealth.identityKey) {
    syncHealthByIdentity.set(syncHealth.identityKey, syncHealth)
  }
  if (syncHealth.phase === 'syncing') armSyncingWatchdog()
  else clearSyncingWatchdog()
  emitSync()
}

export function subscribeSyncHealth(listener: SyncListener): () => void {
  syncListeners.add(listener)
  listener(syncHealth)
  return () => {
    syncListeners.delete(listener)
  }
}

export function isUnlockNudgeNeeded(): boolean {
  return unlockNeeded
}

/** Bridge hit while locked — focus Desktop and show unlock banner. */
export function requestUnlockForBridge(): void {
  const wasNeeded = unlockNeeded
  unlockNeeded = true
  emitUnlock()
  void window.handcash?.focusWindow?.()
  if (!wasNeeded) {
    try {
      // Dynamic import avoided — sound is best-effort from bridge path.
      void import('./soundService').then(({ playWalletSound }) => {
        playWalletSound('deny')
      })
    } catch {
      // ignore
    }
  }
}

export function clearUnlockNudge(): void {
  unlockNeeded = false
  if (unlockClearTimer) {
    clearTimeout(unlockClearTimer)
    unlockClearTimer = null
  }
  emitUnlock()
}

export function subscribeUnlockNudge(listener: UnlockListener): () => void {
  unlockListeners.add(listener)
  listener(unlockNeeded)
  return () => {
    unlockListeners.delete(listener)
  }
}
