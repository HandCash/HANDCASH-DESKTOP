import { durableGetItem, durableSetItem } from './durableStorage'
import { DEFAULT_HISTORY_BACKUP_SETUP_URL, getWalletConfigPrefs } from './walletConfig'

const KEY = 'handcash.brc100.historyBackup.v1'

/**
 * HandCash BRC-39 host (BRC-CLOUD). Applied automatically unless the user
 * chose “no backup” or a custom host.
 */
export const SUGGESTED_HISTORY_BACKUP_BASE_URL = DEFAULT_HISTORY_BACKUP_SETUP_URL

/**
 * Optional remote base URL for BRC-39 blob storage.
 * Empty only after explicit "no backup". Otherwise HandCash cloud is applied
 * by {@link ensureHandCashServiceDefaults} / setup. Override with
 * VITE_HISTORY_BACKUP_BASE_URL when you want a pre-filled default.
 * @deprecated Prefer SUGGESTED_HISTORY_BACKUP_BASE_URL for UI defaults.
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
  /**
   * Highest managed spendable (sats) seen on this install for the linked
   * identity. Auto-push may not drop below this without a higher actionCount
   * (proof UTXOs were spent). Survives IDB wipe; cleared only by force upload
   * that deliberately ratchets down, or when a richer snapshot is restored.
   */
  highWaterSpendableSats: number | null
  /** Action count paired with {@link highWaterSpendableSats}. */
  highWaterActionCount: number | null
}

const DEFAULTS: HistoryBackupPrefs = {
  baseUrl: DEFAULT_HISTORY_BACKUP_BASE_URL,
  lastUploadedAt: null,
  lastError: null,
  highWaterSpendableSats: null,
  highWaterActionCount: null,
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
      highWaterSpendableSats:
        typeof parsed.highWaterSpendableSats === 'number' &&
        Number.isFinite(parsed.highWaterSpendableSats)
          ? Math.max(0, Math.trunc(parsed.highWaterSpendableSats))
          : null,
      highWaterActionCount:
        typeof parsed.highWaterActionCount === 'number' &&
        Number.isFinite(parsed.highWaterActionCount)
          ? Math.max(0, Math.trunc(parsed.highWaterActionCount))
          : null,
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

/**
 * Ratchet local spendable high-water up. Never lowers — thin restores must not
 * erase the floor that blocks clobbering a richer cloud blob.
 */
export function noteSpendableHighWater(spendableSats: number, actionCount: number): void {
  const sats = Math.max(0, Math.trunc(spendableSats))
  const actions = Math.max(0, Math.trunc(actionCount))
  const prefs = getHistoryBackupPrefs()
  const prior = prefs.highWaterSpendableSats
  if (prior != null && sats <= prior) return
  setHistoryBackupPrefs({
    highWaterSpendableSats: sats,
    highWaterActionCount: actions,
  })
}

/**
 * After a guarded push (or forced operator upload), align high-water to what
 * we actually published so future spend-downs compare against the new baseline.
 */
export function setSpendableHighWaterFromPush(
  spendableSats: number,
  actionCount: number,
): void {
  setHistoryBackupPrefs({
    highWaterSpendableSats: Math.max(0, Math.trunc(spendableSats)),
    highWaterActionCount: Math.max(0, Math.trunc(actionCount)),
  })
}

export function resolveHistoryBackupBaseUrl(prefs = getHistoryBackupPrefs()): string {
  return normalizeBaseUrl(prefs.baseUrl)
}

/** Display value: saved URL, else the suggested HandCash cloud host. */
export function displayHistoryBackupBaseUrl(prefs = getHistoryBackupPrefs()): string {
  const saved = resolveHistoryBackupBaseUrl(prefs)
  return saved || SUGGESTED_HISTORY_BACKUP_BASE_URL
}

/** Persist HandCash cloud when the user has none yet (not if they chose no backup). */
export function ensureSuggestedHistoryBackupUrl(): HistoryBackupPrefs {
  const prefs = getHistoryBackupPrefs()
  if (prefs.baseUrl.trim()) return prefs
  if (getWalletConfigPrefs().mode === 'none') return prefs
  return setHistoryBackupPrefs({ baseUrl: SUGGESTED_HISTORY_BACKUP_BASE_URL })
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
