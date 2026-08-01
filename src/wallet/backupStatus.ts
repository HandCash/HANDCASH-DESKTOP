import { durableGetItem, durableSetItem } from './durableStorage'

const KEYS_KEY = 'handcash.brc100.backupConfirmed'
const HISTORY_KEY = 'handcash.brc100.historyBackupConfirmed'

export type BackupStep = 'keys' | 'history'

type Listener = () => void
const listeners = new Set<Listener>()

/** Session evidence before confirm is allowed (not durable — must re-prove). */
let keysHandoffs = 0
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

/** Record a real handoff (email / copy / save) of key material. */
export function noteKeysBackupHandoff(): void {
  keysHandoffs += 1
  notify()
}

export function getKeysBackupHandoffCount(): number {
  return keysHandoffs
}

/** Split needs ≥2 handoffs; phrase/key needs ≥1. */
export function canConfirmKeysBackup(kind: 'split' | 'phrase' | 'key'): boolean {
  const need = kind === 'split' ? 2 : 1
  return keysHandoffs >= need
}

export function markKeysBackupConfirmed(kind: 'split' | 'phrase' | 'key'): boolean {
  if (!canConfirmKeysBackup(kind)) return false
  durableSetItem(KEYS_KEY, '1')
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
  durableSetItem(HISTORY_KEY, '1')
  notify()
  return true
}

export function clearBackupConfirmed(): void {
  try {
    localStorage.removeItem(KEYS_KEY)
    localStorage.removeItem(HISTORY_KEY)
  } catch {
    // ignore
  }
  keysHandoffs = 0
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
