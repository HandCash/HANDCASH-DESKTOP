import { durableGetItem, durableRemoveItem, durableSetItem } from './durableStorage'
import { DEFAULT_BRC_CLOUD_BASE_URL } from './walletConfig'

/** Survives wallet wipe — support endpoint, not custody. */
const KEY = 'handcash.logs.uploadUrl'

function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes)
  crypto.getRandomValues(a)
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** BRC-CLOUD log sink base — agents fetch `/latest` on this host. */
export function defaultLogUploadBaseUrl(): string {
  return `${DEFAULT_BRC_CLOUD_BASE_URL.replace(/\/+$/, '')}/v1/logs`
}

/**
 * POST target is `/v1/logs/<bucket>` only — trailing `/latest`, `/all`, or a
 * specific upload id returns 405 from BRC-CLOUD.
 */
export function normalizeLogUploadUrl(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  try {
    const u = new URL(trimmed)
    const bucketPath = u.pathname.match(/^(\/v1\/logs\/[^/]+)/)
    if (bucketPath) {
      u.pathname = bucketPath[1]!
      u.search = ''
      u.hash = ''
    }
    return u.toString().replace(/\/+$/, '')
  } catch {
    return trimmed.replace(/\/+(latest|all)(?:\/.*)?$/i, '').replace(/\/+$/, '')
  }
}

/**
 * Per-device upload URL. Empty durable prefs get a one-time `hc-<hex>` bucket so
 * crash auto-ship and Settings upload always have a sink without manual setup.
 */
export function getLogUploadUrl(): string {
  const stored = durableGetItem(KEY)?.trim()
  if (stored) {
    const normalized = normalizeLogUploadUrl(stored)
    if (normalized !== stored) durableSetItem(KEY, normalized)
    return normalized
  }
  const url = `${defaultLogUploadBaseUrl()}/hc-${randomHex(10)}`
  durableSetItem(KEY, url)
  return url
}

export function setLogUploadUrl(url: string): string {
  const next = normalizeLogUploadUrl(url)
  if (next) durableSetItem(KEY, next)
  else durableRemoveItem(KEY)
  return next
}
