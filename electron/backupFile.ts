import fs from 'node:fs'
import log from 'electron-log'
import { isDiskFull, writeFileAtomic } from './atomicFile.js'

export type SaveBackupResult =
  | { ok: true; saved: true; path: string; bytes: number }
  | { ok: true; saved: false }
  | { ok: false; error: string }

const MAX_BACKUP_BYTES = 1024 * 1024 * 1024

export function parseSaveBackupPayload(payload: unknown): { filename: string; bytes: Uint8Array } | null {
  if (!payload || typeof payload !== 'object') return null
  const { filename, bytes } = payload as { filename?: unknown; bytes?: unknown }
  if (typeof filename !== 'string' || !filename.trim()) return null
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_BACKUP_BYTES) return null
  return { filename: filename.replace(/[/\\]/g, '-'), bytes }
}

/**
 * Save a backup where the user picks, and report it saved only once the file
 * reads back byte for byte. The write is atomic, so a full disk or a crash
 * leaves no partial file and keeps any file it was replacing.
 */
export async function saveBackupFile(args: {
  filename: string
  bytes: Uint8Array
  choosePath: (defaultPath: string) => Promise<string | null>
}): Promise<SaveBackupResult> {
  const target = await args.choosePath(args.filename)
  if (!target) return { ok: true, saved: false }
  try {
    const result = writeFileAtomic(target, args.bytes, { mode: 0o600 })
    if (!result.directorySynced) log.warn('backup saved, but its folder could not be synced', target, result.error)
    const written = fs.readFileSync(target)
    if (!written.equals(Buffer.from(args.bytes.buffer, args.bytes.byteOffset, args.bytes.byteLength))) {
      log.error('backup file did not read back as written', target)
      return { ok: false, error: 'The saved file did not match the backup. Save it again.' }
    }
    log.info('backup saved', target, written.byteLength)
    return { ok: true, saved: true, path: target, bytes: written.byteLength }
  } catch (err) {
    if (isDiskFull(err)) {
      log.error('backup not saved: the disk is full', target)
      return { ok: false, error: 'The disk is full. Nothing was saved.' }
    }
    log.error('backup not saved', target, err)
    return { ok: false, error: err instanceof Error ? err.message : 'The backup could not be saved.' }
  }
}
