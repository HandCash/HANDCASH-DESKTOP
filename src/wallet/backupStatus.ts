import { durableGetItem, durableRemoveItem, durableSetItem } from './durableStorage'

const KEYS_KEY = 'handcash.brc100.backupConfirmed'
const HISTORY_KEY = 'handcash.brc100.historyBackupConfirmed'

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
  return durableGetItem(KEYS_KEY) === '1'
}

export function isHistoryBackupConfirmed(): boolean {
  return durableGetItem(HISTORY_KEY) === '1'
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
  durableSetItem(KEYS_KEY, '1')
  notify()
  return true
}

/** Cloud trustholder deposit (2 shares) counts as a completed keys backup. */
export function markCloudKeysBackupConfirmed(): void {
  durableSetItem(KEYS_KEY, '1')
  notify()
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
  durableSetItem(HISTORY_KEY, '1')
  notify()
  return true
}

export function clearBackupConfirmed(): void {
  durableRemoveItem(KEYS_KEY)
  durableRemoveItem(HISTORY_KEY)
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
