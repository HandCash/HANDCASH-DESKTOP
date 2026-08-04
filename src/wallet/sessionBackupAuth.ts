/**
 * In-memory unlock password for the active session only.
 * Needed so BRC-39 can re-encrypt after P2P createAction/send without re-prompting.
 * Cleared on lock / wipe — never written to disk.
 */

let sessionPassword: string | null = null

export function setSessionBackupPassword(password: string): void {
  sessionPassword = password || null
}

export function getSessionBackupPassword(): string | null {
  return sessionPassword
}

export function clearSessionBackupPassword(): void {
  sessionPassword = null
}
