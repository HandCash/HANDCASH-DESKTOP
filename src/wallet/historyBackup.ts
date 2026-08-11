/**
 * historyReplica — export/import/upload/download BRC-39 (AES-256-GCM + Argon2id).
 * Replicates toolbox localState (managed change, baskets, remittance metadata).
 * Not chainIngest. See `layers.ts`.
 */
import {
  exportBRC38Json,
  importBRC39,
  type BRC38ImportResult,
  type StorageProvider,
} from '@bsv/wallet-toolbox-client'
import { appendAppLog } from './appLog'
import { encryptBrc39Document } from './brc39Encrypt'
import {
  getHistoryBackupPrefs,
  historyBackupObjectUrl,
  setHistoryBackupPrefs,
} from './historyBackupPrefs'
import { getActiveWallet, clearActiveWallet, bootWallet } from './session'
import { revealRootKeyHex } from './vault'
import { refreshCloudBackupHealth } from './cloudBackupHealth'
import {
  archiveBrc39Locally,
  listLocalBrc39Archive,
  readLocalBrc39Archive,
} from './brc39LocalArchive'
import { runHistoryReplica } from './walletCoordinator'
import {
  isNullMemberRejection,
  repairProvenTxReqHistoryNulls,
  type ProvenTxReqHistoryStore,
} from './brc38HistoryRepair'

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

/**
 * Export, and if BRC-38 validation trips over a null the monitor left in a
 * history note, clear those notes and export once more. Retrying without the
 * repair would fail identically, so a second refusal is the caller's problem.
 */
async function exportBrc38JsonRepairingNulls(
  storage: StorageProvider,
  identityKey: string,
): Promise<string> {
  try {
    return await exportBRC38Json(storage, identityKey)
  } catch (err) {
    if (!isNullMemberRejection(err)) throw err
    appendAppLog('warn', `[cloud-backup] export rejected — ${(err as Error).message}`)
    await repairProvenTxReqHistoryNulls(
      storage as unknown as ProvenTxReqHistoryStore,
      identityKey,
    )
    return await exportBRC38Json(storage, identityKey)
  }
}

export type CreateBrc39Opts = {
  /**
   * Skip the vault re-check. The session password was already proven at unlock,
   * and `revealRootKeyHex` costs a second 210k-iteration PBKDF2 on the UI thread
   * for no extra safety on automatic paths.
   */
  passwordAlreadyVerified?: boolean
}

/** Live BRC-38 JSON under the caller's historyReplica session (or none). */
async function exportLiveBrc38Json(): Promise<string> {
  return withActiveStorageProvider((storage, identityKey) =>
    exportBrc38JsonRepairingNulls(storage, identityKey),
  )
}

/**
 * Snapshot toolbox state under historyReplica, then encrypt outside that lock.
 * Argon2id on a ~26MB document must not block createAction / send.
 */
export async function createBrc39BackupBytes(
  password: string,
  opts: CreateBrc39Opts = {},
): Promise<Uint8Array> {
  if (!opts.passwordAlreadyVerified) await revealRootKeyHex(password)
  const active = getActiveWallet()
  if (!active) throw new Error('Unlock the wallet first')

  const json = await runHistoryReplica(() => exportLiveBrc38Json())
  appendAppLog('info', `[cloud-backup] BRC-38 document ${json.length} chars — encrypting`)
  const out = asArrayBufferBytes(await encryptBrc39Document(json, password))
  // Every export is also a write-once on-device snapshot (never overwritten).
  await archiveBrc39Locally({
    identityKey: active.identityKey,
    bytes: out,
    exportedAt: Date.now(),
  })
  return out
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

/**
 * Export under historyReplica only; encrypt + PUT run unlocked so a sequential
 * mint / pay is not stuck on "Preparing payment" behind Argon2 + upload.
 */
export async function uploadBrc39Backup(
  password: string,
  opts: CreateBrc39Opts = {},
): Promise<{
  url: string
  exportedAt: number
}> {
  if (!opts.passwordAlreadyVerified) await revealRootKeyHex(password)
  const active = getActiveWallet()
  if (!active) throw new Error('Unlock the wallet first')

  const prefs = getHistoryBackupPrefs()
  const url = historyBackupObjectUrl(active.identityKey, prefs)

  const json = await runHistoryReplica(() => exportLiveBrc38Json())
  appendAppLog('info', `[cloud-backup] BRC-38 document ${json.length} chars — encrypting`)
  const bytes = asArrayBufferBytes(await encryptBrc39Document(json, password))
  await archiveBrc39Locally({
    identityKey: active.identityKey,
    bytes,
    exportedAt: Date.now(),
  })

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
  return runHistoryReplica(() => downloadAndRestoreBrc39BackupExclusive(password))
}

async function downloadAndRestoreBrc39BackupExclusive(
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
  appendAppLog(
    'info',
    `[cloud-backup] restored ${buf.byteLength} bytes (merge inserts=${result.inserts} updates=${result.updates})`,
  )
  void refreshCloudBackupHealth()
  return result
}

function deleteIdbDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(name)
      req.onsuccess = () => resolve()
      req.onerror = () => resolve()
      req.onblocked = () => resolve()
    } catch {
      resolve()
    }
  })
}

/**
 * Recovery / replace: wipe this wallet's toolbox IndexedDB, reboot, then merge
 * remote BRC-39 into a clean localState. Avoids LWW merge against soft-latch
 * dust that raced a prior pull (under-restored spendable balance).
 *
 * Keeps the sealed vault (keys). Call only from the history recovery gate or
 * an explicit Settings "Replace from cloud" action — not from soft poll.
 */
export async function replaceLocalHistoryFromCloud(
  password: string,
): Promise<BRC38ImportResult> {
  const active = getActiveWallet()
  if (!active) throw new Error('Unlock the wallet first')
  const { rootKeyHex, handle, chain, identityKey } = active
  const dbName = `handcash-brc100-${chain}-${handle}`

  appendAppLog(
    'info',
    `[cloud-backup] replace local history — wiping ${dbName} then pulling BRC-39`,
  )

  try {
    active.monitor?.stopTasks?.()
  } catch {
    /* optional */
  }
  clearActiveWallet()
  await deleteIdbDatabase(dbName)

  await bootWallet({ rootKeyHex, handle, chain })
  const next = getActiveWallet()
  if (!next || next.identityKey !== identityKey) {
    throw new Error('Wallet reboot after history wipe failed')
  }

  const result = await downloadAndRestoreBrc39Backup(password)
  try {
    const { inspectLocalToolboxState } = await import('./layers')
    const { fetchBalanceSats } = await import('./session')
    const state = await inspectLocalToolboxState()
    const managed = await fetchBalanceSats(next.wallet)
    appendAppLog(
      'info',
      `[cloud-backup] after replace: managed=${managed} defaultOuts=${state.defaultOutputCount} actions=${state.actionCount} oneSat=${state.oneSatOutputCount}`,
    )
  } catch {
    /* diagnostic only */
  }
  return result
}

/** Merge a write-once on-device UTXO snapshot back into localState. */
export async function restoreLocalBrc39Archive(
  password: string,
  snapshotId: string,
): Promise<BRC38ImportResult> {
  const active = getActiveWallet()
  if (!active) throw new Error('Unlock the wallet first')
  const buf = await readLocalBrc39Archive({
    identityKey: active.identityKey,
    id: snapshotId,
  })
  if (buf.length < 64) throw new Error('Local UTXO archive is too small')
  const result = await restoreBrc39BackupBytes(buf, password, 'merge')
  appendAppLog('info', `[utxo-archive] restored local snapshot ${snapshotId}`)
  return result
}

export { listLocalBrc39Archive }
