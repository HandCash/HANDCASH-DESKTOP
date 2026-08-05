import { durableGetItem, durableRemoveItem, durableSetItem } from './durableStorage'

/** Survives wallet wipe — support endpoint, not custody. */
const KEY = 'handcash.logs.uploadUrl'

export function getLogUploadUrl(): string {
  return durableGetItem(KEY)?.trim() ?? ''
}

export function setLogUploadUrl(url: string): string {
  const next = url.trim()
  if (next) durableSetItem(KEY, next)
  else durableRemoveItem(KEY)
  return next
}
