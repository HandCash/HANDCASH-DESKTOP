import os from 'node:os'
import path from 'node:path'

/**
 * Directory for durable host files (prefs, archives, recordings).
 * Native shells and tests set HANDCASH_USER_DATA; otherwise match the old
 * Electron userData layout so leftover tooling still finds files.
 */
export function getUserDataPath(): string {
  const fromEnv = process.env.HANDCASH_USER_DATA?.trim()
  if (fromEnv) return fromEnv
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'handcash-brc100')
  }
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    return path.join(base, 'handcash-brc100')
  }
  return path.join(os.homedir(), '.config', 'handcash-brc100')
}
