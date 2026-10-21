/**
 * Which self-kept backups were saved: the recovery phrase, the BRC-140 key
 * slices and the emergency key, each on its own. The vault-wide confirmation
 * in `backupStatus` predates this and does not say which one.
 */
import { storageRegistry } from '../storage/registry'
import { durableGetItem, durableSetItem } from './durableStorage'
import { openSetting } from './navStore'
import { vaultLocalKey } from './vaultLocalKeys'

export type BackupFormat = 'phrase' | 'split' | 'key'

const KEY = storageRegistry.backupFormatsSaved.key
const FORMATS: readonly BackupFormat[] = ['phrase', 'split', 'key']
const listeners = new Set<() => void>()
let requested: BackupFormat | null = null

export function savedBackupFormats(): Set<BackupFormat> {
  try {
    const parsed = JSON.parse(durableGetItem(vaultLocalKey(KEY)) || '[]') as unknown
    return new Set(Array.isArray(parsed) ? FORMATS.filter((f) => parsed.includes(f)) : [])
  } catch {
    return new Set()
  }
}

export function markBackupFormatSaved(format: BackupFormat): void {
  const saved = savedBackupFormats()
  if (saved.has(format)) return
  saved.add(format)
  durableSetItem(vaultLocalKey(KEY), JSON.stringify([...saved]))
  for (const listener of listeners) listener()
}

export function subscribeBackupFormats(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Opens Recovery backup on one format's tab. */
export function openBackupFormat(format: BackupFormat): void {
  requested = format
  openSetting('backup')
}

/** The tab a caller asked for, once; later opens start on the default tab. */
export function takeRequestedBackupFormat(): BackupFormat | null {
  const format = requested
  requested = null
  return format
}
