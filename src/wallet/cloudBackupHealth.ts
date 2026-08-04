/**
 * Cloud BRC-39 history host health (BRC-CLOUD / compatible servers).
 * “Out of sync” = URL configured but no remote blob (or last upload failed).
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
  label: 'Backup off',
  message: null,
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
  const prefs = getHistoryBackupPrefs()
  if (prefs.baseUrl) return prefs.baseUrl
  const cfg = getWalletConfigPrefs()
  if (cfg.historyBaseUrl.trim()) {
    setHistoryBackupPrefs({ baseUrl: cfg.historyBaseUrl.trim(), lastError: null })
    return resolveHistoryBackupBaseUrl()
  }
  return ''
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
      message: 'No history backup URL configured',
    })
  }

  if (prefs.lastError) {
    setHealth({
      phase: 'error',
      label: 'Backup failed',
      message: prefs.lastError,
    })
  } else {
    setHealth({
      phase: 'checking',
      label: 'Checking backup',
      message: `Probing ${base}`,
    })
  }

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
      label: prefs.lastUploadedAt ? 'Cloud ready' : 'Out of sync',
      message: prefs.lastUploadedAt
        ? 'Host OK — unlock to verify blob'
        : 'Host OK — upload a BRC-39 backup to sync',
    })
  }

  try {
    const objectUrl = historyBackupObjectUrl(active.identityKey)
    const res = await fetch(objectUrl, {
      method: 'GET',
      headers: { Accept: 'application/vnd.brc39.wallet, application/octet-stream, */*' },
    })
    if (res.status === 404) {
      appendAppLog('info', '[cloud-backup] no remote BRC-39 yet — out of sync')
      setHistoryBackupPrefs({ lastError: null })
      return setHealth({
        phase: 'pending',
        label: 'Out of sync',
        message: 'No remote history blob yet — upload from Settings → History',
      })
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 160)
      const msg = `Remote backup check failed (${res.status})${detail ? `: ${detail}` : ''}`
      appendAppLog('warn', `[cloud-backup] ${msg}`)
      setHistoryBackupPrefs({ lastError: msg })
      return setHealth({ phase: 'error', label: 'Backup failed', message: msg })
    }
    // Touch body so Cap/Electron don't cancel; discard.
    await res.arrayBuffer()
    setHistoryBackupPrefs({ lastError: null })
    if (!prefs.lastUploadedAt) {
      setHistoryBackupPrefs({ lastUploadedAt: Date.now() })
    }
    appendAppLog('info', '[cloud-backup] remote BRC-39 present')
    return setHealth({
      phase: 'ok',
      label: 'Cloud synced',
      message: 'Remote history backup is present',
    })
  } catch (err) {
    const msg = `Remote backup check failed: ${err instanceof Error ? err.message : String(err)}`
    appendAppLog('warn', `[cloud-backup] ${msg}`)
    setHistoryBackupPrefs({ lastError: msg })
    return setHealth({ phase: 'error', label: 'Backup failed', message: msg })
  }
}
