/**
 * historyReplica — export/import/upload/download BRC-39 (AES-256-GCM + Argon2id).
 * Replicates toolbox localState (managed change, baskets, remittance metadata).
 * Not chainIngest. See `layers.ts`.
 *
 * Crypto secret is derived from the wallet root key (not the unlock password).
 * Legacy password-encrypted blobs still decrypt; successful legacy pull schedules
 * a re-upload so the cloud upgrades to root-key encryption.
 */
import {
  exportBRC38Json,
  importBRC39,
  type BRC38ImportResult,
  type StorageProvider,
} from '@bsv/wallet-toolbox-client'
import { appendAppLog } from './appLog'
import { encryptBrc39Document } from './brc39Encrypt'
import { historyCryptoSecret } from './historyCryptoSecret'
import {
  getHistoryBackupPrefs,
  historyBackupObjectUrl,
  noteSpendableHighWater,
  setHistoryBackupPrefs,
  setSpendableHighWaterFromPush,
} from './historyBackupPrefs'
import { getActiveWallet, clearActiveWallet, bootWallet } from './session'
import { revealRootKeyHex } from './vault'
import { refreshCloudBackupHealth } from './cloudBackupHealth'
import {
  archiveBrc39Locally,
  listLocalBrc39Archive,
  readLocalBrc39Archive,
} from './brc39LocalArchive'
import { runHistoryReplica, type HistoryReplicaPriority } from './walletCoordinator'
import {
  isNullMemberRejection,
  repairProvenTxReqHistoryNulls,
  type ProvenTxReqHistoryStore,
} from './brc38HistoryRepair'
import { decideHistoryPush } from './historyEmptyGuard'
import { assertHistoryDocumentEncryptable } from './historyDocumentBudget'
import { inspectLocalToolboxState } from './layers'

const BRC39_MEDIA = 'application/vnd.brc39.wallet'

export type HistoryCryptoPath = 'root-key' | 'legacy-password'

export type HistoryImportResult = BRC38ImportResult & {
  crypto: HistoryCryptoPath
}

function asArrayBufferBytes(bytes: number[] | Uint8Array): Uint8Array<ArrayBuffer> {
  const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const out = new Uint8Array(src.byteLength)
  out.set(src)
  return out
}

function requireActiveRootKeyHex(): string {
  const active = getActiveWallet()
  if (!active?.rootKeyHex) throw new Error('Unlock the wallet first')
  return active.rootKeyHex
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
  /**
   * Settings → History Upload: operator confirms overwriting a richer remote /
   * high-water. Auto paths never set this.
   */
  force?: boolean
  /**
   * `starved` stops yielding the historyReplica region to merely-queued spends.
   * Set only by the auto-push after its deferral budget is spent — see
   * {@link HistoryReplicaPriority}.
   */
  priority?: HistoryReplicaPriority
}

export class HistoryThinOverwriteError extends Error {
  readonly code = 'history-thin-overwrite' as const
  constructor(message: string) {
    super(message)
    this.name = 'HistoryThinOverwriteError'
  }
}

function parseOptionalIntHeader(res: Response, name: string): number | null {
  const raw = res.headers.get(name)
  if (raw == null || raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.trunc(n)
}

/** Live BRC-38 JSON under the caller's historyReplica session (or none). */
async function exportLiveBrc38Json(): Promise<string> {
  return withActiveStorageProvider((storage, identityKey) =>
    exportBrc38JsonRepairingNulls(storage, identityKey),
  )
}

async function encryptLiveDocument(rootKeyHex: string, json: string): Promise<Uint8Array> {
  const secret = historyCryptoSecret(rootKeyHex)
  appendAppLog('info', `[cloud-backup] BRC-38 document ${json.length} chars — encrypting (root-key)`)
  assertHistoryDocumentEncryptable(json)
  return asArrayBufferBytes(await encryptBrc39Document(json, secret))
}

function scheduleRootKeyMigratePush(): void {
  void import('./deviceSync')
    .then(({ scheduleHistoryBackupPush }) => {
      scheduleHistoryBackupPush('history-key-migrate')
    })
    .catch(() => {
      /* optional */
    })
}

/**
 * Decrypt + import: root-key secret first, then unlock password (legacy blobs).
 */
async function importBrc39Bytes(
  storage: StorageProvider,
  bytes: number[] | Uint8Array,
  rootKeyHex: string,
  legacyPassword: string | null | undefined,
  mode: 'merge' | 'restore',
): Promise<HistoryImportResult> {
  const secret = historyCryptoSecret(rootKeyHex)
  try {
    const result = await importBRC39(storage, bytes, secret, { mode })
    return { ...result, crypto: 'root-key' }
  } catch (rootErr) {
    const legacy = legacyPassword?.trim()
    if (!legacy) throw rootErr
    try {
      const result = await importBRC39(storage, bytes, legacy, { mode })
      appendAppLog(
        'info',
        '[cloud-backup] decrypted with legacy unlock password — will re-upload as root-key',
      )
      scheduleRootKeyMigratePush()
      return { ...result, crypto: 'legacy-password' }
    } catch {
      throw rootErr
    }
  }
}

/**
 * Snapshot toolbox state under historyReplica, then encrypt outside that lock.
 * Argon2id on a document this size must not block createAction / send, and a
 * document too large to encrypt at all is refused — see
 * `historyDocumentBudget.ts`.
 *
 * `password` is only used to prove vault access when not already verified —
 * the BRC-39 ciphertext is sealed to the root key.
 */
export async function createBrc39BackupBytes(
  password: string,
  opts: CreateBrc39Opts = {},
): Promise<Uint8Array> {
  if (!opts.passwordAlreadyVerified) await revealRootKeyHex(password)
  const active = getActiveWallet()
  if (!active) throw new Error('Unlock the wallet first')

  const json = await runHistoryReplica(() => exportLiveBrc38Json(), opts.priority)
  const out = await encryptLiveDocument(active.rootKeyHex, json)
  await archiveBrc39Locally({
    identityKey: active.identityKey,
    bytes: out,
    exportedAt: Date.now(),
  })
  return out
}

export async function restoreBrc39BackupBytes(
  bytes: number[] | Uint8Array,
  password?: string | null,
  mode: 'merge' | 'restore' = 'merge',
): Promise<HistoryImportResult> {
  const active = getActiveWallet()
  if (!active) throw new Error('Unlock the wallet first')
  // `password` is only a legacy BRC-39 decrypt fallback — not vault proof.
  return withActiveStorageProvider((storage) =>
    importBrc39Bytes(storage, bytes, active.rootKeyHex, password, mode),
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

export async function exportBrc39ToFile(
  password: string,
  opts: CreateBrc39Opts = {},
): Promise<void> {
  const bytes = await createBrc39BackupBytes(password, opts)
  const active = getActiveWallet()
  const tag = active?.identityKey?.slice(0, 8) ?? 'wallet'
  downloadBrc39File(bytes, `wallet-${tag}.brc39`)
}

export async function importBrc39FromFile(
  file: File,
  password?: string | null,
): Promise<HistoryImportResult> {
  const buf = new Uint8Array(await file.arrayBuffer())
  if (buf.length < 64) throw new Error('File is too small to be a BRC-39 backup')
  return restoreBrc39BackupBytes(buf, password, 'merge')
}

/**
 * Export under historyReplica only; encrypt + PUT run unlocked so a sequential
 * mint / pay is not stuck on "Preparing payment" behind Argon2 + upload.
 *
 * Fail-closed: will not PUT a thinner managed balance over a richer remote /
 * high-water unless {@link CreateBrc39Opts.force} or local actionCount proves
 * UTXOs were spent.
 */
export async function uploadBrc39Backup(
  password: string,
  opts: CreateBrc39Opts = {},
): Promise<{
  url: string
  exportedAt: number
  spendableSats: number
  actionCount: number
}> {
  if (!opts.passwordAlreadyVerified) await revealRootKeyHex(password)
  const active = getActiveWallet()
  if (!active) throw new Error('Unlock the wallet first')

  const prefs = getHistoryBackupPrefs()
  const url = historyBackupObjectUrl(active.identityKey, prefs)

  const local = await inspectLocalToolboxState()
  const remote = await fetchRemoteBrc39Meta()
  if (remote == null && opts.force !== true) {
    const msg = 'refuse history upload while remote BRC-39 metadata is unavailable'
    appendAppLog('warn', `[cloud-backup] skip upload — ${msg}`)
    setHistoryBackupPrefs({ lastError: msg })
    throw new HistoryThinOverwriteError(msg)
  }
  const prefsNow = getHistoryBackupPrefs()
  const gate = decideHistoryPush({
    remoteExists: remote?.exists ?? false,
    remoteBytes: remote?.bytes ?? null,
    localLooksEmpty: local.looksEmpty,
    localSpendableSats: local.spendableSats,
    localActionCount: local.actionCount,
    remoteSpendableSats: remote?.spendableSats ?? null,
    remoteActionCount: remote?.actionCount ?? null,
    highWaterSpendableSats: prefsNow.highWaterSpendableSats,
    highWaterActionCount: prefsNow.highWaterActionCount,
    force: opts.force === true,
  })
  if (gate.refusePush) {
    const msg = gate.reason ?? 'refuse thin history overwrite'
    appendAppLog('info', `[cloud-backup] skip upload — ${msg}`)
    setHistoryBackupPrefs({ lastError: msg })
    throw new HistoryThinOverwriteError(msg)
  }

  const json = await runHistoryReplica(() => exportLiveBrc38Json(), opts.priority)
  const bytes = asArrayBufferBytes(await encryptLiveDocument(active.rootKeyHex, json))
  await archiveBrc39Locally({
    identityKey: active.identityKey,
    bytes,
    exportedAt: Date.now(),
  })

  const exportedAt = Date.now()
  appendAppLog(
    'info',
    `[cloud-backup] uploading ${bytes.byteLength} bytes → ${url} (spendable=${local.spendableSats} actions=${local.actionCount})`,
  )

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': BRC39_MEDIA,
      Accept: 'application/json, application/octet-stream, */*',
      'X-HandCash-Exported-At': String(exportedAt),
      'X-HandCash-Spendable-Sats': String(local.spendableSats),
      'X-HandCash-Action-Count': String(local.actionCount),
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
  setSpendableHighWaterFromPush(local.spendableSats, local.actionCount)
  appendAppLog('info', '[cloud-backup] upload ok (root-key)')
  void refreshCloudBackupHealth()
  return {
    url,
    exportedAt,
    spendableSats: local.spendableSats,
    actionCount: local.actionCount,
  }
}

/** Probe remote blob age / richness without downloading/merging. */
export async function fetchRemoteBrc39Meta(): Promise<{
  exists: boolean
  exportedAt: number | null
  bytes: number | null
  spendableSats: number | null
  actionCount: number | null
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
    if (res.status === 404) {
      return {
        exists: false,
        exportedAt: null,
        bytes: null,
        spendableSats: null,
        actionCount: null,
      }
    }
    if (!res.ok) return null
    const exportedRaw = res.headers.get('X-HandCash-Exported-At')
    const exportedAt = exportedRaw ? Number(exportedRaw) : null
    const len = res.headers.get('Content-Length')
    return {
      exists: true,
      exportedAt: Number.isFinite(exportedAt) && exportedAt! > 0 ? exportedAt : null,
      bytes: len ? Number(len) : null,
      spendableSats: parseOptionalIntHeader(res, 'X-HandCash-Spendable-Sats'),
      actionCount: parseOptionalIntHeader(res, 'X-HandCash-Action-Count'),
    }
  } catch {
    return null
  }
}

export async function downloadAndRestoreBrc39Backup(
  password?: string | null,
): Promise<HistoryImportResult> {
  return runHistoryReplica(() => downloadAndRestoreBrc39BackupExclusive(password))
}

async function downloadAndRestoreBrc39BackupExclusive(
  password?: string | null,
): Promise<HistoryImportResult> {
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
  const result = await withActiveStorageProvider((storage) =>
    importBrc39Bytes(storage, buf, active.rootKeyHex, password, 'merge'),
  )
  setHistoryBackupPrefs({
    lastError: null,
    lastUploadedAt:
      Number.isFinite(remoteExportedAt) && remoteExportedAt > 0
        ? Math.max(remoteExportedAt, prefs.lastUploadedAt ?? 0)
        : Date.now(),
  })
  appendAppLog(
    'info',
    `[cloud-backup] restored ${buf.byteLength} bytes via ${result.crypto} (inserts=${result.inserts} updates=${result.updates})`,
  )
  try {
    const state = await inspectLocalToolboxState()
    noteSpendableHighWater(state.spendableSats, state.actionCount)
    const remoteSats = parseOptionalIntHeader(res, 'X-HandCash-Spendable-Sats')
    const remoteActions = parseOptionalIntHeader(res, 'X-HandCash-Action-Count')
    if (remoteSats != null) {
      noteSpendableHighWater(remoteSats, remoteActions ?? state.actionCount)
    }
  } catch {
    /* high-water best-effort */
  }
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
 * Keeps the sealed vault (keys). History decrypt uses the root key (optional
 * unlock password only for legacy blobs).
 */
export async function replaceLocalHistoryFromCloud(
  password?: string | null,
): Promise<HistoryImportResult> {
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
      `[cloud-backup] after replace: managed=${managed} defaultOuts=${state.defaultOutputCount} actions=${state.actionCount} oneSat=${state.oneSatOutputCount} crypto=${result.crypto}`,
    )
  } catch {
    /* diagnostic only */
  }
  return result
}

/** Merge a write-once on-device UTXO snapshot back into localState. */
export async function restoreLocalBrc39Archive(
  password: string | null | undefined,
  snapshotId: string,
): Promise<HistoryImportResult> {
  const active = getActiveWallet()
  if (!active) throw new Error('Unlock the wallet first')
  const buf = await readLocalBrc39Archive({
    identityKey: active.identityKey,
    id: snapshotId,
  })
  if (buf.length < 64) throw new Error('Local UTXO archive is too small')
  const result = await restoreBrc39BackupBytes(buf, password, 'merge')
  appendAppLog(
    'info',
    `[utxo-archive] restored local snapshot ${snapshotId} via ${result.crypto}`,
  )
  return result
}

export { listLocalBrc39Archive, requireActiveRootKeyHex }