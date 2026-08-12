/**
 * Cloud BRC-39 historyReplica health (BRC-CLOUD / compatible servers).
 * Pending = URL configured but no remote blob yet (optional multi-device parity).
 * This is not chainIngest — missing cloud history does not mean missing on-chain funds.
 * See `layers.ts`.
 */
import { appendAppLog } from './appLog'
import {
  getHistoryBackupPrefs,
  historyBackupObjectUrl,
  resolveHistoryBackupBaseUrl,
  setHistoryBackupPrefs,
} from './historyBackupPrefs'
import { getActiveWallet } from './session'
import { getWalletConfigPrefs } from './walletConfig'
import { ensureHandCashServiceDefaults } from './walletSetupApply'

export type CloudBackupPhase = 'off' | 'checking' | 'pending' | 'ok' | 'error'

export type CloudBackupHealth = {
  phase: CloudBackupPhase
  /** Short status for the titlebar. */
  label: string
  message: string | null
  checkedAt: number
}

type Listener = (h: CloudBackupHealth) => void

const listeners = new Set<Listener>()

let health: CloudBackupHealth = {
  phase: 'off',
  label: 'Not synced',
  message: 'Inactive',
  checkedAt: 0,
}

function emit() {
  for (const l of listeners) l(health)
}

export function getCloudBackupHealth(): CloudBackupHealth {
  return health
}

export function subscribeCloudBackupHealth(listener: Listener): () => void {
  listeners.add(listener)
  listener(health)
  return () => {
    listeners.delete(listener)
  }
}

function setHealth(next: Omit<CloudBackupHealth, 'checkedAt'>): CloudBackupHealth {
  health = { ...next, checkedAt: Date.now() }
  emit()
  return health
}

/** Ensure History prefs pick up wallet-config URL if the user never opened History. */
export function ensureHistoryBackupUrlFromConfig(): string {
  ensureHandCashServiceDefaults()
  const prefs = getHistoryBackupPrefs()
  if (prefs.baseUrl) return prefs.baseUrl
  const cfg = getWalletConfigPrefs()
  // Explicit "no backup" — do not promote a leftover / setup URL into active sync.
  if (cfg.mode === 'none') return ''
  if (cfg.historyBaseUrl.trim()) {
    setHistoryBackupPrefs({ baseUrl: cfg.historyBaseUrl.trim(), lastError: null })
    return resolveHistoryBackupBaseUrl()
  }
  return ''
}

async function probeRemoteBrc39Exists(identityKey: string): Promise<{
  exists: boolean
  exportedAt: number | null
}> {
  const url = historyBackupObjectUrl(identityKey)
  const res = await fetch(url, {
    method: 'HEAD',
    headers: { Accept: 'application/vnd.brc39.wallet, application/octet-stream, */*' },
  })
  if (res.status === 404) return { exists: false, exportedAt: null }
  if (!res.ok) throw new Error(`Remote backup check failed (${res.status})`)
  const exportedRaw = res.headers.get('X-HandCash-Exported-At')
  const exportedAt = exportedRaw ? Number(exportedRaw) : null
  return {
    exists: true,
    exportedAt: Number.isFinite(exportedAt) && exportedAt! > 0 ? exportedAt : null,
  }
}

/**
 * Probe the configured history host and whether a BRC-39 blob exists for this identity.
 */
export async function refreshCloudBackupHealth(): Promise<CloudBackupHealth> {
  const base = ensureHistoryBackupUrlFromConfig()
  const prefs = getHistoryBackupPrefs()

  if (!base) {
    return setHealth({
      phase: 'off',
      label: 'Backup off',
      message: 'Inactive — history backup not configured',
    })
  }

  if (prefs.lastError) {
    setHealth({
      phase: 'error',
      label: 'Backup failed',
      message: prefs.lastError,
    })
  }
  // Soft probe — keep the last stable label; do not flash "Checking backup".

  try {
    const healthUrl = `${base.replace(/\/+$/, '')}/health`
    const healthRes = await fetch(healthUrl, {
      method: 'GET',
      headers: { Accept: 'application/json, */*' },
    })
    if (!healthRes.ok) {
      const msg = `Backup host unhealthy (${healthRes.status})`
      appendAppLog('warn', `[cloud-backup] ${msg}`)
      setHistoryBackupPrefs({ lastError: msg })
      return setHealth({ phase: 'error', label: 'Backup failed', message: msg })
    }
  } catch (err) {
    const msg = `Backup host unreachable: ${err instanceof Error ? err.message : String(err)}`
    appendAppLog('warn', `[cloud-backup] ${msg}`)
    setHistoryBackupPrefs({ lastError: msg })
    return setHealth({ phase: 'error', label: 'Backup failed', message: msg })
  }

  const active = getActiveWallet()
  if (!active) {
    return setHealth({
      phase: prefs.lastUploadedAt ? 'ok' : 'pending',
      label: prefs.lastUploadedAt ? 'Cloud ready' : 'Backup pending',
      message: prefs.lastUploadedAt
        ? 'Host OK — unlock to verify blob'
        : 'Host OK — upload a BRC-39 backup when unlocked',
    })
  }

  try {
    const meta = await probeRemoteBrc39Exists(active.identityKey)
    if (!meta.exists) {
      // Local already pushed — treat as ok even if HEAD briefly lags.
      if (prefs.lastUploadedAt) {
        appendAppLog('info', '[cloud-backup] local upload recorded; remote HEAD not found yet')
        return setHealth({
          phase: 'ok',
          label: 'Cloud synced',
          message: 'History backup uploaded from this device',
        })
      }
      appendAppLog('info', '[cloud-backup] no remote BRC-39 yet — backup pending')
      setHistoryBackupPrefs({ lastError: null })
      return setHealth({
        phase: 'pending',
        label: 'Backup pending',
        message: 'No remote history blob yet — auto-upload will retry',
      })
    }
    setHistoryBackupPrefs({ lastError: null })
    // Do not invent lastUploadedAt from a HEAD probe — that blocks empty-local
    // recovery pull and lies that this device already pushed.
    appendAppLog('info', '[cloud-backup] remote BRC-39 present')
    return setHealth({
      phase: 'ok',
      label: 'Cloud synced',
      message: prefs.lastUploadedAt
        ? 'Remote history backup is present'
        : 'Remote history present — unlock sync will merge if this device is empty',
    })
  } catch (err) {
    const msg = `Remote backup check failed: ${err instanceof Error ? err.message : String(err)}`
    appendAppLog('warn', `[cloud-backup] ${msg}`)
    setHistoryBackupPrefs({ lastError: msg })
    return setHealth({ phase: 'error', label: 'Backup failed', message: msg })
  }
}
