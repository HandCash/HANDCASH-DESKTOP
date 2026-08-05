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
 * - Auto and explicit Sync may pull only when remote is **strictly newer** than local.
 */
import { listFriends, mergeFriends, type Friend } from './friends'
import {
  downloadAndRestoreBrc39Backup,
  fetchRemoteBrc39Meta,
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

let historyDirty = false
let pushTimer: ReturnType<typeof setTimeout> | null = null
let pushInFlight: Promise<void> | null = null

const PUSH_DEBOUNCE_MS = 2_500


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
 * Requires the vault password (same password on both devices for BRC-39).
 */
export async function syncDevicesViaBackupUrl(password: string): Promise<{
  brc39: { inserts: number; updates: number } | null
  friendsMerged: number
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
  await uploadBrc39Backup(password)
  await uploadFriendsBackup()
  setHistoryBackupPrefs({ lastError: null })

  return { brc39, friendsMerged, uploaded: true, pulled, skippedPullReason }
}

/**
 * Mark local toolbox history dirty after a P2P spend/receive so BRC-39 can catch up.
 */
export function markHistoryBackupDirty(): void {
  historyDirty = true
}

/**
 * Debounced BRC-39 push using the in-memory session password (post-spend path).
 */
export function scheduleHistoryBackupPush(reason = 'dirty'): void {
  if (!hasDeviceLinkBackupUrl()) return
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
    void flushHistoryBackupPush(reason)
  }, PUSH_DEBOUNCE_MS)
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
  pushInFlight = autoPushHistoryBackupIfConfigured(password, { reason, allowEmptyPull: false })
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

/**
 * Best-effort historyReplica sync after create/unlock (and debounced post-spend push).
 * Empty-local × remote edge case is isolated in `historyEmptyGuard.ts` — auto paths
 * never PUT an empty localState over a protected remote blob.
 */
export async function autoPushHistoryBackupIfConfigured(
  password: string,
  opts: AutoPushOpts = {},
): Promise<void> {
  if (!password) return
  const reason = opts.reason ?? 'unlock'
  const allowEmptyPull =
    opts.allowEmptyPull ?? allowEmptyLocalHistoryPull(reason)
  try {
    const { ensureHistoryBackupUrlFromConfig } = await import('./cloudBackupHealth')
    ensureHistoryBackupUrlFromConfig()
  } catch {
    /* ignore */
  }
  if (!hasDeviceLinkBackupUrl()) return
  try {
    const { appendAppLog } = await import('./appLog')
    appendAppLog('info', `[cloud-backup] auto-sync starting (${reason})`)
    await Promise.race([
      (async () => {
        const remote = await fetchRemoteBrc39Meta()
        const emptyLocal = await localToolboxStateLooksEmpty()
        const remoteExists = Boolean(remote?.exists)
        const remoteBytes = remote?.bytes ?? null

        if (allowEmptyPull && remoteExists && emptyLocal) {
          appendAppLog(
            'info',
            '[cloud-backup] empty localState + remote BRC-39 — pulling historyReplica',
          )
          try {
            await downloadAndRestoreBrc39Backup(password)
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            appendAppLog('warn', `[cloud-backup] empty-local pull failed: ${msg}`)
          }
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
          return
        }

        await uploadBrc39Backup(password)
        await uploadFriendsBackup()
        historyDirty = false
      })(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('auto-sync timed out')), 45_000),
      ),
    ])
    appendAppLog('info', `[cloud-backup] auto-sync ok (${reason})`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    try {
      const { appendAppLog } = await import('./appLog')
      appendAppLog('warn', `[cloud-backup] auto-sync failed (${reason}): ${msg}`)
    } catch {
      /* ignore */
    }
  }
}

export function deviceLinkObjectHint(identityKey: string): string | null {
  try {
    return historyBackupObjectUrl(identityKey)
  } catch {
    return null
  }
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
    await downloadAndRestoreBrc39Backup(password)
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
