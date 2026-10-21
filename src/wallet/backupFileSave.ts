export type BackupSaveOutcome = { saved: true; path: string } | { saved: false }

/**
 * Save a backup file through the desktop app. `saved` means the file was
 * written and read back intact; cancelling the dialog saves nothing. Throws
 * when the save fails, a full disk included.
 */
export async function saveBackupFile(filename: string, contents: string | Uint8Array): Promise<BackupSaveOutcome> {
  const save = window.handcash?.saveBackupFile
  if (!save) throw new Error('Saving a backup file needs the HandCash desktop app')
  const bytes = typeof contents === 'string' ? new TextEncoder().encode(contents) : contents
  const result = await save({ filename, bytes })
  if (!result.ok) throw new Error(result.error)
  return result.saved ? { saved: true, path: result.path } : { saved: false }
}
