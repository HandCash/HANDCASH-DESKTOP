import { probeRemoteBrc39 } from './historyRemoteProbe'
import { getActiveWallet } from './session'

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

import { getWalletConfigPrefs } from './walletConfig'
import { ensureHandCashServiceDefaults } from './walletSetupApply'

/** `delayed` = the host is down or throttling everyone; `error` = this backup is misconfigured or refused. */
export type CloudBackupPhase = 'off' | 'checking' | 'pending' | 'ok' | 'delayed' | 'error'

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

function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
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

  if (prefs.lastError && health.phase !== 'delayed') {
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
    const head = await probeRemoteBrc39(active.rootKeyHex, historyBackupObjectUrl(active.identityKey))
    if (head.kind === 'unavailable') {
      return setHealth({
        phase: 'delayed',
        label: 'Backup delayed',
        message:
          `Backup host is not accepting requests (${head.status ?? 'unreachable'}: ${head.reason}). ` +
          `Retrying after ${clockTime(head.retryAt)}.`,
      })
    }
    if (head.kind === 'refused') {
      throw new Error(`Remote backup check refused (${head.status}: ${head.reason})`)
    }
    if (head.kind === 'absent') {
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
