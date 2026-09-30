/**
 * In-memory unlock password for the active session only.
 * Needed so BRC-39 can re-encrypt after P2P createAction/send without re-prompting.
 * Cleared on lock / wipe — never written to disk.
 */
import { getWalletRuntime } from './walletRuntime'

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

/**
 * Authority for a BRC-39 push or pull this session: the unlock password, `''`
 * for a wallet unlocked without one, or null while locked.
 *
 * Uploads are root-key encrypted, and the root key is in memory once unlocked;
 * the password only decrypts legacy password-encrypted blobs. Device unlock sets
 * no password, and gating on one silently stopped every backup — a later
 * restore of that stale snapshot then replaced a live balance (hc-a580a,
 * 2026-09-30).
 */
export function sessionBackupCredential(): string | null {
  if (sessionPassword) return sessionPassword
  return getWalletRuntime()?.instance.rootKeyHex ? '' : null
}
