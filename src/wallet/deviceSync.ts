/**
 * Multi-device **historyReplica** via shared BRC-39 backup URL (+ friends sidecar).
 * Same base URL on both installs is required to link devices.
 *
 * This layer replicas `localState` (toolbox IndexedDB). It is not chainIngest —
 * Refresh cannot substitute for a missing BRC-39. See `layers.ts`.
 *
 * Rules:
 * - Auto unlock: pull only when localState looks empty and a remote blob
 *   exists (recover P2P / managed-change state). Otherwise push-only so a
 *   stale cloud blob cannot rewind a live device.
 * - After createAction / send / internalize: mark dirty and debounce-push so
 *   remittance packages in IndexedDB are not only on one machine.
 * - Never auto-overwrite a non-empty remote with an empty local export.
 * - Never auto-overwrite a richer remote / spendable high-water with a thinner
 *   local unless actionCount proves UTXOs were spent (dispensed).
 * - Auto and explicit Sync may pull only when remote is **strictly newer** than local.
 */
import { listFriends, mergeFriends, type Friend } from './friends'
import {
  downloadAndRestoreBrc39Backup,
  fetchRemoteBrc39Meta,
  HistoryThinOverwriteError,
  uploadBrc39Backup,
} from './historyBackup'
import {
  getHistoryBackupPrefs,
  historyBackupObjectUrl,
  resolveHistoryBackupBaseUrl,
  setHistoryBackupPrefs,
} from './historyBackupPrefs'
import { getActiveWallet } from './session'
import { getSessionBackupPassword } from './sessionBackupAuth'
import { localToolboxStateLooksEmpty } from './layers'
import {
  allowEmptyLocalHistoryPull,
  decideEmptyHistoryOverwrite,
} from './historyEmptyGuard'
import {
  backupBlockedReason,
  closeBackupAttempt,
  openBackupAttempt,
} from './backupWatchdog'

let historyDirty = false
let pushTimer: ReturnType<typeof setTimeout> | null = null
let pushInFlight: Promise<void> | null = null

const PUSH_DEBOUNCE_MS = 2_500
/**
 * After spends — wait before Argon2 on ~26MB BRC-38. Encrypting on the UI thread
 * right after sign/broadcast freezes the phone for tens of seconds (lab stalls).
 */
const POST_SPEND_PUSH_DEBOUNCE_MS = 45_000

/** Unlock must not encrypt a ~26MB BRC-38 on the UI thread before first paint. */
const UNLOCK_PUSH_DEBOUNCE_MS = 60_000

function pushDebounceMs(reason: string): number {
  if (reason === 'unlock' || reason === 'create') {
    return UNLOCK_PUSH_DEBOUNCE_MS
  }
  if (
    reason === 'createAction' ||
    reason === 'signAction' ||
    reason === 'send' ||
    reason === 'sendCollectable' ||
    reason === 'internalizeAction'
  ) {
    return POST_SPEND_PUSH_DEBOUNCE_MS
  }
  return PUSH_DEBOUNCE_MS
}

async function permissionPromptBlocksBackup(reason: string): Promise<boolean> {
  try {
    const { hasPendingPermissionPrompt } = await import('./permissions')
    if (!hasPendingPermissionPrompt()) return false
    const { appendAppLog } = await import('./appLog')
    appendAppLog(
      'info',
      `[cloud-backup] defer (${reason}) — permission prompt pending`,
    )
    return true
  } catch {
    return false
  }
}

function normalizeBase(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

export function hasDeviceLinkBackupUrl(): boolean {
  return Boolean(resolveHistoryBackupBaseUrl())
}

export function assertDeviceLinkBackupUrl(): string {
  const base = resolveHistoryBackupBaseUrl()
  if (!base) {
    throw new Error('Set the same History backup URL on both devices to link them')
  }
  return base
}

export function friendsBackupObjectUrl(
  identityKey: string,
  prefs = getHistoryBackupPrefs(),
): string {
  const base = resolveHistoryBackupBaseUrl(prefs)
  if (!base) throw new Error('Set a backup URL first')
  const id = encodeURIComponent(identityKey.trim())
  return `${base}/v1/wallets/${id}/friends.json`
}

export function activityBackupObjectUrl(
  identityKey: string,
  prefs = getHistoryBackupPrefs(),
): string {
  const base = resolveHistoryBackupBaseUrl(prefs)
  if (!base) throw new Error('Set a backup URL first')
  const id = encodeURIComponent(identityKey.trim())
  return `${base}/v1/wallets/${id}/activity.json`
}

export function backupUrlsMatch(a: string, b: string): boolean {
  return normalizeBase(a).toLowerCase() === normalizeBase(b).toLowerCase()
}

/** Push friends list to the shared backup host (same base as BRC-39). */
export async function uploadFriendsBackup(): Promise<{ url: string; count: number }> {
  const active = getActiveWallet()
  if (!active) throw new Error('Unlock the wallet first')
  assertDeviceLinkBackupUrl()
  const friends = listFriends()
  const url = friendsBackupObjectUrl(active.identityKey)
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, */*',
    },
    body: JSON.stringify({
      v: 1,
      identityKey: active.identityKey,
      updatedAt: Date.now(),
      friends,
    }),
  })
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 160)
    throw new Error(`Friends upload failed (${res.status})${detail ? `: ${detail}` : ''}`)
  }
  return { url, count: friends.length }
}

/** Pull + merge friends from the shared backup host. */
export async function downloadAndMergeFriendsBackup(): Promise<number> {
  const active = getActiveWallet()
  if (!active) throw new Error('Unlock the wallet first')
  assertDeviceLinkBackupUrl()
  const url = friendsBackupObjectUrl(active.identityKey)
  const res = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json, */*' },
  })
  if (res.status === 404) return 0
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 160)
    throw new Error(`Friends download failed (${res.status})${detail ? `: ${detail}` : ''}`)
  }
  const data = (await res.json()) as { friends?: Friend[]; identityKey?: string }
  if (data.identityKey && data.identityKey !== active.identityKey) {
    throw new Error('Friends backup identity does not match this wallet')
  }
  const incoming = Array.isArray(data.friends) ? data.friends : []
  return mergeFriends(incoming)
}

/** Push Activity panel rows (local durable store) beside BRC-39 / friends. */
export async function uploadActivityBackup(): Promise<{ url: string; count: number }> {
  const active = getActiveWallet()
  if (!active) throw new Error('Unlock the wallet first')
  assertDeviceLinkBackupUrl()
  const { exportAllActivity } = await import('./appActivity')
  const entries = exportAllActivity()
  const url = activityBackupObjectUrl(active.identityKey)
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, */*',
    },
    body: JSON.stringify({
      v: 1,
      identityKey: active.identityKey,
      updatedAt: Date.now(),
      entries,
    }),
  })
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 160)
    throw new Error(`Activity upload failed (${res.status})${detail ? `: ${detail}` : ''}`)
  }
  return { url, count: entries.length }
}

/** Pull + merge Activity rows from the shared backup host. */
export async function downloadAndMergeActivityBackup(): Promise<number> {
  const active = getActiveWallet()
  if (!active) throw new Error('Unlock the wallet first')
  assertDeviceLinkBackupUrl()
  const url = activityBackupObjectUrl(active.identityKey)
  const res = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json, */*' },
  })
  if (res.status === 404) return 0
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 160)
    throw new Error(`Activity download failed (${res.status})${detail ? `: ${detail}` : ''}`)
  }
  const data = (await res.json()) as {
    entries?: unknown
    identityKey?: string
  }
  if (data.identityKey && data.identityKey !== active.identityKey) {
    throw new Error('Activity backup identity does not match this wallet')
  }
  const incoming = Array.isArray(data.entries) ? data.entries : []
  const { mergeActivityEntries } = await import('./appActivity')
  return mergeActivityEntries(incoming as import('./appActivity').ActivityEntry[])
}

/**
 * True when remote history is strictly newer than what this device last pushed.
 * If age is unknown, refuse to pull (safe default — never go backwards).
 */
export function shouldPullRemoteHistory(
  remoteExportedAt: number | null,
  localUploadedAt: number | null,
): boolean {
  if (remoteExportedAt == null || !Number.isFinite(remoteExportedAt) || remoteExportedAt <= 0) {
    return false
  }
  if (localUploadedAt == null || localUploadedAt <= 0) {
    // First link on this device — allow pull of a known-timestamp remote.
    return true
  }
  return remoteExportedAt > localUploadedAt
}

/**
 * Explicit multi-device sync: pull only if remote is newer, then push local.
 * Requires the vault unlock password on this device (operator confirm). BRC-39
 * itself is sealed to the root key; password is also a legacy-decrypt fallback.
 */
export async function syncDevicesViaBackupUrl(password: string): Promise<{
  brc39: { inserts: number; updates: number } | null
  friendsMerged: number
  activityMerged: number
  uploaded: boolean
  pulled: boolean
  skippedPullReason: string | null
}> {
  assertDeviceLinkBackupUrl()
  const prefs = getHistoryBackupPrefs()
  let brc39: { inserts: number; updates: number } | null = null
  let pulled = false
  let skippedPullReason: string | null = null

  const remote = await fetchRemoteBrc39Meta()
  if (!remote || !remote.exists) {
    skippedPullReason = 'no remote history yet'
  } else if (!shouldPullRemoteHistory(remote.exportedAt, prefs.lastUploadedAt)) {
    skippedPullReason =
      remote.exportedAt == null
        ? 'remote age unknown — refusing pull to protect local history'
        : 'local history is same or newer than remote'
    try {
      const { appendAppLog } = await import('./appLog')
      appendAppLog('info', `[cloud-backup] skip pull: ${skippedPullReason}`)
    } catch {
      /* ignore */
    }
  } else {
    try {
      const result = await downloadAndRestoreBrc39Backup(password)
      brc39 = { inserts: result.inserts, updates: result.updates }
      pulled = true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!/404|No BRC-39/i.test(msg)) throw err
      skippedPullReason = 'no remote history yet'
    }
  }

  const friendsMerged = await downloadAndMergeFriendsBackup()
  const activityMerged = await downloadAndMergeActivityBackup().catch(() => 0)
  try {
    await uploadBrc39Backup(password)
  } catch (err) {
    if (err instanceof HistoryThinOverwriteError) {
      return {
        brc39,
        friendsMerged,
        activityMerged,
        uploaded: false,
        pulled,
        skippedPullReason:
          skippedPullReason ??
          `push refused — ${err.message}`,
      }
    }
    throw err
  }
  await uploadFriendsBackup()
  await uploadActivityBackup().catch(() => undefined)
  setHistoryBackupPrefs({ lastError: null })

  return {
    brc39,
    friendsMerged,
    activityMerged,
    uploaded: true,
    pulled,
    skippedPullReason,
  }
}

/**
 * Mark local toolbox history dirty after a P2P spend/receive so BRC-39 can catch up.
 */
export function markHistoryBackupDirty(): void {
  historyDirty = true
}

/**
 * Debounced BRC-39 push using the in-memory session password (post-spend path).
 * Always archives a write-once local UTXO snapshot first — even when no cloud URL
 * is configured — so on-device history cannot be lost by an empty IndexedDB wipe.
 *
 * Yields to in-flight / queued spends: Argon2 + upload must not sit on the wallet
 * FIFO ahead of createAction (sequential mint hung on "Preparing payment").
 */
export function scheduleHistoryBackupPush(reason = 'dirty'): void {
  if (!getSessionBackupPassword()) {
    void import('./appLog').then(({ appendAppLog }) =>
      appendAppLog('info', `[cloud-backup] skip schedule (${reason}): no session password`),
    )
    return
  }
  markHistoryBackupDirty()
  if (pushTimer) clearTimeout(pushTimer)
  pushTimer = setTimeout(() => {
    pushTimer = null
    void (async () => {
      try {
        const { shouldYieldChainIngestToSpend } = await import('./walletCoordinator')
        if (shouldYieldChainIngestToSpend()) {
          const { appendAppLog } = await import('./appLog')
          appendAppLog(
            'info',
            `[cloud-backup] defer schedule (${reason}) — spend waiting`,
          )
          scheduleHistoryBackupPush(reason)
          return
        }
      } catch {
        /* coordinator optional during early boot */
      }
      if (await permissionPromptBlocksBackup(reason)) {
        scheduleHistoryBackupPush(reason)
        return
      }
      await flushHistoryBackupPush(reason)
    })()
  }, pushDebounceMs(reason))
}

async function flushHistoryBackupPush(reason: string): Promise<void> {
  if (pushInFlight) {
    await pushInFlight
    if (historyDirty) return flushHistoryBackupPush(reason)
    return
  }
  const password = getSessionBackupPassword()
  if (!password || !historyDirty) return
  historyDirty = false
  pushInFlight = (async () => {
    if (hasDeviceLinkBackupUrl()) {
      await autoPushHistoryBackupIfConfigured(password, { reason, allowEmptyPull: false })
      return
    }
    // No cloud URL — still write an immutable local UTXO snapshot. Same Argon2id
    // cost as a cloud push, so it answers to the same crash-loop guard.
    const blocked = backupBlockedReason()
    if (blocked) {
      const { appendAppLog } = await import('./appLog')
      appendAppLog('info', `[utxo-archive] skip local snapshot (${reason}) — ${blocked}`)
      return
    }
    openBackupAttempt()
    try {
      const { createBrc39BackupBytes } = await import('./historyBackup')
      await createBrc39BackupBytes(password, { passwordAlreadyVerified: true })
      closeBackupAttempt(true)
    } catch (err) {
      closeBackupAttempt(false)
      if (
        err instanceof Error &&
        (err.name === 'HistoryDeferredForSpendError' ||
          /payment is waiting/i.test(err.message))
      ) {
        historyDirty = true
        scheduleHistoryBackupPush(reason)
        return
      }
      try {
        const { appendAppLog } = await import('./appLog')
        const msg = err instanceof Error ? err.message : String(err)
        appendAppLog('warn', `[utxo-archive] local snapshot failed (${reason}): ${msg}`)
      } catch {
        /* ignore */
      }
    }
  })()
    .catch(() => {
      /* logged inside */
    })
    .finally(() => {
      pushInFlight = null
    })
  await pushInFlight
}

export type AutoPushOpts = {
  reason?: string
  /** On unlock: recover empty local from remote before pushing. */
  allowEmptyPull?: boolean
}

export type AutoSyncResult = {
  /** Empty-local pull restored remote BRC-39 into this device. */
  pulled: boolean
  /** Decrypt/import failed while trying to recover empty local. */
  pullError: string | null
  /**
   * Early exit before push work (no URL, watchdog backoff, etc.).
   * Empty-local pull may still have run — see `pulled` / `pullError`.
   */
  skipReason: string | null
}

/**
 * Best-effort historyReplica sync after create/unlock/restore (and debounced
 * post-spend push). Empty-local × remote edge case is isolated in
 * `historyEmptyGuard.ts` — auto paths never PUT an empty localState over a
 * protected remote blob.
 *
 * Push may be deferred or watchdog-blocked; empty-local **pull** is not —
 * restore/unlock must recover balance + TX history even when a prior backup
 * attempt is still marked open.
 */
export async function autoPushHistoryBackupIfConfigured(
  password: string,
  opts: AutoPushOpts = {},
): Promise<AutoSyncResult> {
  const result: AutoSyncResult = {
    pulled: false,
    pullError: null,
    skipReason: null,
  }
  if (!password) {
    result.skipReason = 'no password'
    return result
  }
  const reason = opts.reason ?? 'unlock'
  const allowEmptyPull =
    opts.allowEmptyPull ?? allowEmptyLocalHistoryPull(reason)
  try {
    const { ensureHistoryBackupUrlFromConfig } = await import('./cloudBackupHealth')
    ensureHistoryBackupUrlFromConfig()
  } catch {
    /* ignore */
  }
  if (!hasDeviceLinkBackupUrl()) {
    result.skipReason = 'no backup url'
    return result
  }

  const { appendAppLog } = await import('./appLog')

  // Recovery pull first — never gated by the push crash-loop watchdog.
  let remoteExists = false
  let remoteBytes: number | null = null
  if (allowEmptyPull) {
    try {
      const remote = await fetchRemoteBrc39Meta()
      remoteExists = Boolean(remote?.exists)
      remoteBytes = remote?.bytes ?? null
      const emptyLocal = await localToolboxStateLooksEmpty()
      if (remoteExists && emptyLocal) {
        appendAppLog(
          'info',
          '[cloud-backup] empty localState + remote BRC-39 — pulling historyReplica',
        )
        try {
          await downloadAndRestoreBrc39Backup(password)
          result.pulled = true
          await downloadAndMergeFriendsBackup().catch(() => 0)
          await downloadAndMergeActivityBackup().catch(() => 0)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          result.pullError = msg
          appendAppLog('warn', `[cloud-backup] empty-local pull failed: ${msg}`)
          if (
            /decrypt|password|passphrase|auth|mac|argon|gcm|cipher|invalid/i.test(
              msg,
            )
          ) {
            appendAppLog(
              'warn',
              '[cloud-backup] history blob could not be decrypted with root key or unlock password',
            )
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      appendAppLog('warn', `[cloud-backup] empty-local pull probe failed: ${msg}`)
    }
  }

  const blocked = backupBlockedReason()
  if (blocked) {
    appendAppLog('info', `[cloud-backup] skip push (${reason}) — ${blocked}`)
    result.skipReason = blocked
    return result
  }

  let attemptOpen = false
  try {
    appendAppLog('info', `[cloud-backup] auto-sync starting (${reason})`)
    await Promise.race([
      (async () => {
        if (!allowEmptyPull || remoteBytes == null) {
          const remote = await fetchRemoteBrc39Meta()
          remoteExists = Boolean(remote?.exists)
          remoteBytes = remote?.bytes ?? null
        }

        const stillEmpty = await localToolboxStateLooksEmpty()
        const gate = decideEmptyHistoryOverwrite({
          remoteExists,
          remoteBytes,
          localLooksEmpty: stillEmpty,
        })
        if (gate.refusePush) {
          appendAppLog('info', `[cloud-backup] skip push — ${gate.reason}`)
          await uploadFriendsBackup().catch(() => undefined)
          await uploadActivityBackup().catch(() => undefined)
          return
        }

        // Unlock/create/restore: never encrypt+upload on the hot path — Argon2
        // on a ~26MB BRC-38 freezes the renderer so permission prompts never
        // answer (WALLET_BRIDGE_TIMEOUT). Mark dirty and push after the UI is free.
        if (
          reason === 'unlock' ||
          reason === 'create' ||
          reason === 'restore'
        ) {
          appendAppLog(
            'info',
            `[cloud-backup] defer push after ${reason} — keep UI free for permissions`,
          )
          scheduleHistoryBackupPush(reason)
          return
        }

        // Marked durably before the export: if the app dies inside Argon2id,
        // the next launch sees an unclosed attempt and backs off instead of
        // repeating the crash.
        openBackupAttempt()
        attemptOpen = true
        await uploadBrc39Backup(password, { passwordAlreadyVerified: true })
        closeBackupAttempt(true)
        attemptOpen = false
        await uploadFriendsBackup()
        await uploadActivityBackup().catch(() => undefined)
        historyDirty = false
      })(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('auto-sync timed out')), 180_000),
      ),
    ])
    appendAppLog('info', `[cloud-backup] auto-sync ok (${reason})`)
  } catch (err) {
    if (attemptOpen) closeBackupAttempt(false)
    const msg = err instanceof Error ? err.message : String(err)
    if (
      err instanceof Error &&
      (err.name === 'HistoryDeferredForSpendError' ||
        /payment is waiting/i.test(msg))
    ) {
      historyDirty = true
      appendAppLog('info', `[cloud-backup] deferred (${reason}) — spend waiting`)
      scheduleHistoryBackupPush(reason)
      return result
    }
    if (
      err instanceof HistoryThinOverwriteError ||
      (err instanceof Error && err.name === 'HistoryThinOverwriteError')
    ) {
      appendAppLog('info', `[cloud-backup] auto-sync skipped (${reason}): ${msg}`)
      result.skipReason = msg
      return result
    }
    try {
      appendAppLog('warn', `[cloud-backup] auto-sync failed (${reason}): ${msg}`)
    } catch {
      /* ignore */
    }
    if (!result.pullError) result.pullError = msg
  }
  return result
}

export function deviceLinkObjectHint(identityKey: string): string | null {
  try {
    return historyBackupObjectUrl(identityKey)
  } catch {
    return null
  }
}

export function isHistoryBackupDirty(): boolean {
  return historyDirty
}

/**
 * Soft history pull run by the Dashboard poll when parity is on.
 * Pulls only if remote is strictly newer — never pushes, never empty-overwrites.
 * Rate-limited by the caller; it is a network round trip, not a chain read.
 */
export async function softPullHistoryIfRemoteNewer(): Promise<{
  pulled: boolean
  reason: string | null
}> {
  const password = getSessionBackupPassword()
  if (!password) return { pulled: false, reason: 'no session password' }
  if (!hasDeviceLinkBackupUrl()) return { pulled: false, reason: 'no backup url' }
  // Don't merge remote while a local spend/import is waiting to push.
  if (historyDirty || pushInFlight) {
    return { pulled: false, reason: 'local history dirty' }
  }
  try {
    const { hasPendingPermissionPrompt } = await import('./permissions')
    if (hasPendingPermissionPrompt()) {
      return { pulled: false, reason: 'permission prompt pending' }
    }
  } catch {
    /* ignore */
  }

  try {
    const prefs = getHistoryBackupPrefs()
    const remote = await fetchRemoteBrc39Meta()
    if (!remote?.exists) return { pulled: false, reason: 'no remote history yet' }
    if (!shouldPullRemoteHistory(remote.exportedAt, prefs.lastUploadedAt)) {
      return {
        pulled: false,
        reason:
          remote.exportedAt == null
            ? 'remote age unknown'
            : 'local history is same or newer',
      }
    }
    // Re-check after the HEAD — a spend may have dirtied meanwhile.
    if (historyDirty || pushInFlight) {
      return { pulled: false, reason: 'local history dirty' }
    }
    await downloadAndRestoreBrc39Backup(password)
    await downloadAndMergeFriendsBackup().catch(() => 0)
    await downloadAndMergeActivityBackup().catch(() => 0)
    try {
      const { clearCollectablesCache } = await import('./collectables')
      clearCollectablesCache()
    } catch {
      /* ignore */
    }
    try {
      const { appendAppLog } = await import('./appLog')
      appendAppLog('info', '[cloud-backup] soft pull — remote was newer')
    } catch {
      /* ignore */
    }
    return { pulled: true, reason: null }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    try {
      const { appendAppLog } = await import('./appLog')
      appendAppLog('warn', `[cloud-backup] soft pull failed: ${msg}`)
    } catch {
      /* ignore */
    }
    return { pulled: false, reason: msg }
  }
}
