import { storageRegistry } from '../storage/registry'
import { durableGetItem, durableRemoveItem, durableSetItem } from './durableStorage'
import { accountLocalKey } from './accountLocalKeys'

const KEYS_KEY = storageRegistry.backupConfirmed.key
const HISTORY_KEY = storageRegistry.historyBackupConfirmed.key
const BACKUP_LATER_KEY = storageRegistry.backupDeferred.key

export type BackupStep = 'keys' | 'history'

type Listener = () => void
const listeners = new Set<Listener>()

/** Session confirmations before final backup confirm is allowed (not durable). */
let keysHandoffs = 0
/** Distinct BRC-140 slice indices handed off this session (split backup). */
const keysHandoffSliceIndices = new Set<number>()
/** Phrase / emergency key copied once. */
let keysSingleHandoff = false
let historyExported = false

function notify() {
  for (const listener of listeners) listener()
}

export function isKeysBackupConfirmed(): boolean {
  return durableGetItem(accountLocalKey(KEYS_KEY)) === '1'
}

export function isKeysBackupDeferred(): boolean {
  return (
    durableGetItem(accountLocalKey(BACKUP_LATER_KEY)) === '1' &&
    !isKeysBackupConfirmed()
  )
}

/** Onboarding "I'll do this later" — Settings still nags until confirmed. */
export function markKeysBackupDeferred(): void {
  if (isKeysBackupConfirmed()) return
  durableSetItem(accountLocalKey(BACKUP_LATER_KEY), '1')
  notify()
}

export function clearKeysBackupDeferred(): void {
  durableRemoveItem(accountLocalKey(BACKUP_LATER_KEY))
  notify()
}


export function isHistoryBackupConfirmed(): boolean {
  return durableGetItem(accountLocalKey(HISTORY_KEY)) === '1'
}

/** Both keys and history backups are confirmed. */
export function isBackupConfirmed(): boolean {
  return isKeysBackupConfirmed() && isHistoryBackupConfirmed()
}

/** First incomplete backup step, or null when both are done. */
export function getMissingBackupStep(): BackupStep | null {
  if (!isKeysBackupConfirmed()) return 'keys'
  if (!isHistoryBackupConfirmed()) return 'history'
  return null
}

/**
 * Record explicit user confirmation that key material was saved.
 * Handoff actions must not call this automatically. For split backup, pass the
 * slice index so progress tracks two separately confirmed slices.
 */
export function noteKeysBackupHandoff(sliceIndex?: number): void {
  if (sliceIndex === undefined || sliceIndex < 0) {
    keysSingleHandoff = true
    keysHandoffs += 1
  } else {
    if (!keysHandoffSliceIndices.has(sliceIndex)) {
      keysHandoffSliceIndices.add(sliceIndex)
      keysHandoffs += 1
    }
  }
  notify()
}

/** Clear session handoff evidence (e.g. after rotating to a new share set). */
export function clearKeysHandoffEvidence(): void {
  keysHandoffs = 0
  keysHandoffSliceIndices.clear()
  keysSingleHandoff = false
  notify()
}

export function getKeysBackupHandoffCount(): number {
  return keysHandoffs
}

export function isSliceHandedOff(sliceIndex: number): boolean {
  return keysHandoffSliceIndices.has(sliceIndex)
}

export function getKeysSplitHandoffProgress(need = 2): {
  saved: number
  need: number
  savedIndices: number[]
} {
  const savedIndices = [...keysHandoffSliceIndices].sort((a, b) => a - b)
  return { saved: savedIndices.length, need, savedIndices }
}

/** Split needs ≥2 distinct slices; phrase/key needs ≥1 handoff. */
export function canConfirmKeysBackup(kind: 'split' | 'phrase' | 'key'): boolean {
  if (kind === 'split') return keysHandoffSliceIndices.size >= 2
  return keysSingleHandoff
}

export function markKeysBackupConfirmed(kind: 'split' | 'phrase' | 'key'): boolean {
  if (!canConfirmKeysBackup(kind)) return false
  durableSetItem(accountLocalKey(KEYS_KEY), '1')
  durableRemoveItem(accountLocalKey(BACKUP_LATER_KEY))
  notify()
  return true
}

export function noteHistoryBackupExport(): void {
  historyExported = true
  notify()
}

export function canConfirmHistoryBackup(): boolean {
  return historyExported
}

export function markHistoryBackupConfirmed(): boolean {
  if (!historyExported) return false
  durableSetItem(accountLocalKey(HISTORY_KEY), '1')
  notify()
  return true
}

export function clearBackupConfirmed(): void {
  durableRemoveItem(accountLocalKey(KEYS_KEY))
  durableRemoveItem(accountLocalKey(HISTORY_KEY))
  durableRemoveItem(accountLocalKey(BACKUP_LATER_KEY))
  keysHandoffs = 0
  keysHandoffSliceIndices.clear()
  keysSingleHandoff = false
  historyExported = false
  notify()
}

/** Drop account-bound session evidence after the active vault account changes. */
export function rebindBackupStatusForAccount(): void {
  keysHandoffs = 0
  keysHandoffSliceIndices.clear()
  keysSingleHandoff = false
  historyExported = false
  notify()
}

export function subscribeBackupConfirmed(listener: Listener): () => void {
  listeners.add(listener)
  listener()
  return () => {
    listeners.delete(listener)
  }
}
