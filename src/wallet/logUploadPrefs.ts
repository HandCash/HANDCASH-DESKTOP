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
 * Per-device upload URL. Empty durable prefs get a one-time `hc-<hex>` bucket so
 * crash auto-ship and Settings upload always have a sink without manual setup.
 */
export function getLogUploadUrl(): string {
  const stored = durableGetItem(KEY)?.trim()
  if (stored) return stored
  const url = `${defaultLogUploadBaseUrl()}/hc-${randomHex(10)}`
  durableSetItem(KEY, url)
  return url
}

export function setLogUploadUrl(url: string): string {
  const next = url.trim()
  if (next) durableSetItem(KEY, next)
  else durableRemoveItem(KEY)
  return next
}
