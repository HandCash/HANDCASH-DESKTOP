import { durableGetItem, durableSetItem } from './durableStorage'

const KEY = 'handcash.brc100.historyBackup.v1'

/**
 * Optional remote base URL for BRC-39 blob storage.
 * Blank by default (no HandCash endpoint yet). Override with VITE_HISTORY_BACKUP_BASE_URL when ready.
 */
export const DEFAULT_HISTORY_BACKUP_BASE_URL =
  (typeof import.meta !== 'undefined' &&
    typeof import.meta.env?.VITE_HISTORY_BACKUP_BASE_URL === 'string' &&
    import.meta.env.VITE_HISTORY_BACKUP_BASE_URL.trim()) ||
  ''

export type HistoryBackupPrefs = {
  /** Remote base URL (no trailing slash). Empty = file-only backups. */
  baseUrl: string
  lastUploadedAt: number | null
  lastError: string | null
}

const DEFAULTS: HistoryBackupPrefs = {
  baseUrl: DEFAULT_HISTORY_BACKUP_BASE_URL,
  lastUploadedAt: null,
  lastError: null,
}

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

export function getHistoryBackupPrefs(): HistoryBackupPrefs {
  try {
    const raw = durableGetItem(KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw) as Partial<HistoryBackupPrefs> & {
      customBaseUrl?: string
      provider?: string
    }
    const legacyUrl =
      typeof parsed.customBaseUrl === 'string' ? parsed.customBaseUrl : ''
    const baseUrl =
      typeof parsed.baseUrl === 'string'
        ? parsed.baseUrl
        : legacyUrl || DEFAULT_HISTORY_BACKUP_BASE_URL
    return {
      baseUrl: normalizeBaseUrl(baseUrl),
      lastUploadedAt:
        typeof parsed.lastUploadedAt === 'number' ? parsed.lastUploadedAt : null,
      lastError: typeof parsed.lastError === 'string' ? parsed.lastError : null,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

export function setHistoryBackupPrefs(patch: Partial<HistoryBackupPrefs>): HistoryBackupPrefs {
  const current = getHistoryBackupPrefs()
  const next: HistoryBackupPrefs = {
    ...current,
    ...patch,
    baseUrl:
      patch.baseUrl !== undefined ? normalizeBaseUrl(patch.baseUrl) : current.baseUrl,
  }
  durableSetItem(KEY, JSON.stringify(next))
  return next
}

export function resolveHistoryBackupBaseUrl(prefs = getHistoryBackupPrefs()): string {
  return normalizeBaseUrl(prefs.baseUrl)
}

/** PUT/GET target for a wallet.brc39 blob. */
export function historyBackupObjectUrl(
  identityKey: string,
  prefs = getHistoryBackupPrefs(),
): string {
  const base = resolveHistoryBackupBaseUrl(prefs)
  if (!base) throw new Error('Set a backup URL first')
  const id = encodeURIComponent(identityKey.trim())
  return `${base}/v1/wallets/${id}/wallet.brc39`
}
