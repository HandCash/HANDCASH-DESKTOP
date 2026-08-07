/**
 * User-visible **chainIngest** health — review/import outcomes + held 1-sats / unlock nudges.
 * History replica health lives in `cloudBackupHealth.ts`. See `layers.ts`.
 *
 * Soft in-flight sync does not invent a long pill label — the status bubble stays
 * on a short "Syncing…" while details live in `message` (tooltip).
 */

export type SyncHealth = {
  phase: 'idle' | 'syncing' | 'ok' | 'error'
  /** Longer user-facing line; null when quiet. */
  message: string | null
  heldOneSats: number
  /** Held tips a co-created BRC-156 latch proves are items, still awaiting an origin. */
  pendingTips: number
  updatedAt: number
}

type SyncListener = (health: SyncHealth) => void
type UnlockListener = (needed: boolean) => void

const syncListeners = new Set<SyncListener>()
const unlockListeners = new Set<UnlockListener>()

let syncHealth: SyncHealth = {
  phase: 'idle',
  message: null,
  heldOneSats: 0,
  pendingTips: 0,
  updatedAt: 0,
}

let unlockNeeded = false
let unlockClearTimer: ReturnType<typeof setTimeout> | null = null

function emitSync() {
  for (const l of syncListeners) l(syncHealth)
}

function emitUnlock() {
  for (const l of unlockListeners) l(unlockNeeded)
}

export function getSyncHealth(): SyncHealth {
  return syncHealth
}

export function setSyncHealth(patch: Partial<SyncHealth>): void {
  syncHealth = {
    ...syncHealth,
    ...patch,
    updatedAt: Date.now(),
  }
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
