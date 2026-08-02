import {
  exportBRC39,
  importBRC39,
  type BRC38ImportResult,
  type StorageProvider,
} from '@bsv/wallet-toolbox-client'
import {
  getHistoryBackupPrefs,
  historyBackupObjectUrl,
  setHistoryBackupPrefs,
} from './historyBackupPrefs'
import { getActiveWallet } from './session'
import { revealRootKeyHex } from './vault'

const BRC39_MEDIA = 'application/vnd.brc39.wallet'

function asArrayBufferBytes(bytes: number[] | Uint8Array): Uint8Array<ArrayBuffer> {
  const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const out = new Uint8Array(src.byteLength)
  out.set(src)
  return out
}

async function withActiveStorageProvider<T>(
  fn: (storage: StorageProvider, identityKey: string) => Promise<T>,
): Promise<T> {
  const active = getActiveWallet()
  if (!active) throw new Error('Unlock the wallet first')
  if (!active.wallet.storage.isActiveStorageProvider()) {
    throw new Error('Active wallet storage cannot export BRC-38/39 data')
  }
  return active.wallet.storage.runAsStorageProvider((storage) =>
    fn(storage, active.identityKey),
  )
}

/** Verify unlock password, then export canonical BRC-39 bytes (AES-256-GCM + Argon2id). */
export async function createBrc39BackupBytes(password: string): Promise<Uint8Array> {
  await revealRootKeyHex(password)
  const bytes = await withActiveStorageProvider((storage, identityKey) =>
    exportBRC39(storage, identityKey, password),
  )
  return asArrayBufferBytes(bytes)
}

export async function restoreBrc39BackupBytes(
  bytes: number[] | Uint8Array,
  password: string,
  mode: 'merge' | 'restore' = 'merge',
): Promise<BRC38ImportResult> {
  await revealRootKeyHex(password)
  return withActiveStorageProvider((storage) =>
    importBRC39(storage, bytes, password, { mode }),
  )
}

/**
 * Merge a BRC-39 blob into the already-unlocked active wallet.
 * `brc39Password` decrypts the file only — it may differ from this device's vault password
 * (device-link transfers use the source password for the blob).
 */
export async function importBrc39IntoActiveWallet(
  bytes: number[] | Uint8Array,
  brc39Password: string,
  mode: 'merge' | 'restore' = 'merge',
): Promise<BRC38ImportResult> {
  return withActiveStorageProvider((storage) =>
    importBRC39(storage, bytes, brc39Password, { mode }),
  )
}

export function downloadBrc39File(bytes: Uint8Array, filename = 'wallet.brc39'): void {
  const copy = asArrayBufferBytes(bytes)
  const blob = new Blob([copy], { type: BRC39_MEDIA })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export async function exportBrc39ToFile(password: string): Promise<void> {
  const bytes = await createBrc39BackupBytes(password)
  const active = getActiveWallet()
  const tag = active?.identityKey?.slice(0, 8) ?? 'wallet'
  downloadBrc39File(bytes, `wallet-${tag}.brc39`)
}

export async function importBrc39FromFile(
  file: File,
  password: string,
): Promise<BRC38ImportResult> {
  const buf = new Uint8Array(await file.arrayBuffer())
  if (buf.length < 64) throw new Error('File is too small to be a BRC-39 backup')
  return restoreBrc39BackupBytes(buf, password, 'merge')
}

export async function uploadBrc39Backup(password: string): Promise<{
  url: string
  exportedAt: number
}> {
  const active = getActiveWallet()
  if (!active) throw new Error('Unlock the wallet first')

  const prefs = getHistoryBackupPrefs()
  const url = historyBackupObjectUrl(active.identityKey, prefs)
  const bytes = asArrayBufferBytes(await createBrc39BackupBytes(password))
  const exportedAt = Date.now()

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': BRC39_MEDIA,
      Accept: 'application/json, application/octet-stream, */*',
    },
    body: bytes,
  })
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200)
    const msg = `Upload failed (${res.status})${detail ? `: ${detail}` : ''}`
    setHistoryBackupPrefs({ lastError: msg })
    throw new Error(msg)
  }

  setHistoryBackupPrefs({ lastUploadedAt: exportedAt, lastError: null })
  return { url, exportedAt }
}

export async function downloadAndRestoreBrc39Backup(
  password: string,
): Promise<BRC38ImportResult> {
  const active = getActiveWallet()
  if (!active) throw new Error('Unlock the wallet first')

  const prefs = getHistoryBackupPrefs()
  const url = historyBackupObjectUrl(active.identityKey, prefs)

  const res = await fetch(url, {
    method: 'GET',
    headers: { Accept: `${BRC39_MEDIA}, application/octet-stream, */*` },
  })
  if (res.status === 404) throw new Error('No BRC-39 backup found at this URL')
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200)
    throw new Error(`Download failed (${res.status})${detail ? `: ${detail}` : ''}`)
  }

  const buf = new Uint8Array(await res.arrayBuffer())
  const result = await restoreBrc39BackupBytes(buf, password, 'merge')
  setHistoryBackupPrefs({ lastError: null })
  return result
}
