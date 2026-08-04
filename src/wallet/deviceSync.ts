/**
 * Multi-device parity via shared BRC-39 backup URL (+ friends sidecar).
 * Same base URL on both installs is required to link devices.
 *
 * Rules:
 * - Auto unlock path is **push-only** (never pull). Pulling a stale cloud blob
 *   can reintroduce spent outs and make the balance go backwards.
 * - Explicit Sync may pull only when remote is **strictly newer** than local.
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
 * Best-effort cloud **push** after create/unlock when a history backup URL is configured.
 * Never pulls — unlocking must not rewind local history from a stale cloud blob.
 */
export async function autoPushHistoryBackupIfConfigured(password: string): Promise<void> {
  if (!password) return
  try {
    const { ensureHistoryBackupUrlFromConfig } = await import('./cloudBackupHealth')
    ensureHistoryBackupUrlFromConfig()
  } catch {
    /* ignore */
  }
  if (!hasDeviceLinkBackupUrl()) return
  try {
    const { appendAppLog } = await import('./appLog')
    appendAppLog('info', '[cloud-backup] auto-push starting (push-only)')
    await Promise.race([
      (async () => {
        await uploadBrc39Backup(password)
        await uploadFriendsBackup()
      })(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('auto-push timed out')), 20_000),
      ),
    ])
    appendAppLog('info', '[cloud-backup] auto-push ok')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    try {
      const { appendAppLog } = await import('./appLog')
      appendAppLog('warn', `[cloud-backup] auto-push failed: ${msg}`)
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
