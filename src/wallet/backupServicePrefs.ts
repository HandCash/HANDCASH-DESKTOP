import { durableGetItem, durableSetItem } from './durableStorage'

const KEY = 'handcash.brc100.backupServices.v1'

/** Curated defaults — intentionally empty until HandCash operators ship. */
export const DEFAULT_BACKUP_SERVICE_URLS: string[] = []

export type BackupServiceEnrollment = {
  url: string
  label: string
  userIdHash: string
  shareIndex: number
  integrity: string
  enrolledAt: number
  email: string
}

export type BackupServicePrefs = {
  /** User-configured service base URLs (no trailing slash). */
  urls: string[]
  enrollments: BackupServiceEnrollment[]
}

function normalizeUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

function defaults(): BackupServicePrefs {
  return {
    urls: [...DEFAULT_BACKUP_SERVICE_URLS],
    enrollments: [],
  }
}

export function getBackupServicePrefs(): BackupServicePrefs {
  try {
    const raw = durableGetItem(KEY)
    if (!raw) return defaults()
    const parsed = JSON.parse(raw) as Partial<BackupServicePrefs>
    const urls = Array.isArray(parsed.urls)
      ? parsed.urls.map(normalizeUrl).filter(Boolean)
      : [...DEFAULT_BACKUP_SERVICE_URLS]
    const enrollments = Array.isArray(parsed.enrollments)
      ? parsed.enrollments.filter(
          (e): e is BackupServiceEnrollment =>
            Boolean(e && typeof e.url === 'string' && typeof e.userIdHash === 'string'),
        )
      : []
    return { urls, enrollments }
  } catch {
    return defaults()
  }
}

export function setBackupServicePrefs(patch: Partial<BackupServicePrefs>): BackupServicePrefs {
  const current = getBackupServicePrefs()
  const next: BackupServicePrefs = {
    urls:
      patch.urls !== undefined
        ? [...new Set(patch.urls.map(normalizeUrl).filter(Boolean))]
        : current.urls,
    enrollments: patch.enrollments !== undefined ? patch.enrollments : current.enrollments,
  }
  durableSetItem(KEY, JSON.stringify(next))
  return next
}

export function addBackupServiceUrl(url: string): BackupServicePrefs {
  const normalized = normalizeUrl(url)
  if (!normalized) return getBackupServicePrefs()
  const current = getBackupServicePrefs()
  if (current.urls.includes(normalized)) return current
  return setBackupServicePrefs({ urls: [...current.urls, normalized] })
}

export function removeBackupServiceUrl(url: string): BackupServicePrefs {
  const normalized = normalizeUrl(url)
  const current = getBackupServicePrefs()
  return setBackupServicePrefs({
    urls: current.urls.filter((u) => u !== normalized),
    enrollments: current.enrollments.filter((e) => normalizeUrl(e.url) !== normalized),
  })
}

export function upsertEnrollment(entry: BackupServiceEnrollment): BackupServicePrefs {
  const current = getBackupServicePrefs()
  const url = normalizeUrl(entry.url)
  const rest = current.enrollments.filter((e) => normalizeUrl(e.url) !== url)
  return setBackupServicePrefs({
    enrollments: [...rest, { ...entry, url }],
  })
}
