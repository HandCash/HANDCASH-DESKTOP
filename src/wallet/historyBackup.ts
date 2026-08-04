/**
 * historyReplica — export/import/upload/download BRC-39 (AES-256-GCM + Argon2id).
 * Replicates toolbox localState (managed change, baskets, remittance metadata).
 * Not chainIngest. See `layers.ts`.
 */
import {
  exportBRC39,
  importBRC39,
  type BRC38ImportResult,
  type StorageProvider,
} from '@bsv/wallet-toolbox-client'
import { appendAppLog } from './appLog'
import {
  getHistoryBackupPrefs,
  historyBackupObjectUrl,
  setHistoryBackupPrefs,
} from './historyBackupPrefs'
import { getActiveWallet } from './session'
import { revealRootKeyHex } from './vault'
import { refreshCloudBackupHealth } from './cloudBackupHealth'

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
  appendAppLog('info', `[cloud-backup] uploading ${bytes.byteLength} bytes → ${url}`)

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': BRC39_MEDIA,
      Accept: 'application/json, application/octet-stream, */*',
      'X-HandCash-Exported-At': String(exportedAt),
    },
    body: new Blob([bytes], { type: BRC39_MEDIA }),
  })
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200)
    const msg = `Upload failed (${res.status})${detail ? `: ${detail}` : ''}`
    appendAppLog('error', `[cloud-backup] ${msg}`)
    setHistoryBackupPrefs({ lastError: msg })
    void refreshCloudBackupHealth()
    throw new Error(msg)
  }

  setHistoryBackupPrefs({ lastUploadedAt: exportedAt, lastError: null })
  appendAppLog('info', '[cloud-backup] upload ok')
  void refreshCloudBackupHealth()
  return { url, exportedAt }
}

/** Probe remote blob age without downloading/merging. */
export async function fetchRemoteBrc39Meta(): Promise<{
  exists: boolean
  exportedAt: number | null
  bytes: number | null
} | null> {
  const active = getActiveWallet()
  if (!active) return null
  const prefs = getHistoryBackupPrefs()
  let url: string
  try {
    url = historyBackupObjectUrl(active.identityKey, prefs)
  } catch {
    return null
  }
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      headers: { Accept: `${BRC39_MEDIA}, application/octet-stream, */*` },
    })
    if (res.status === 404) return { exists: false, exportedAt: null, bytes: null }
    if (!res.ok) return null
    const exportedRaw = res.headers.get('X-HandCash-Exported-At')
    const exportedAt = exportedRaw ? Number(exportedRaw) : null
    const len = res.headers.get('Content-Length')
    return {
      exists: true,
      exportedAt: Number.isFinite(exportedAt) && exportedAt! > 0 ? exportedAt : null,
      bytes: len ? Number(len) : null,
    }
  } catch {
    return null
  }
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

  const remoteExportedAt = Number(res.headers.get('X-HandCash-Exported-At') || '')
  const buf = new Uint8Array(await res.arrayBuffer())
  const result = await restoreBrc39BackupBytes(buf, password, 'merge')
  setHistoryBackupPrefs({
    lastError: null,
    lastUploadedAt:
      Number.isFinite(remoteExportedAt) && remoteExportedAt > 0
        ? Math.max(remoteExportedAt, prefs.lastUploadedAt ?? 0)
        : Date.now(),
  })
  appendAppLog('info', `[cloud-backup] restored ${buf.byteLength} bytes`)
  void refreshCloudBackupHealth()
  return result
}
