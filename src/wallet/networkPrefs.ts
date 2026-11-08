/**
 * Unified network opt-out preference.
 *
 * When enabled, disables ALL network egress:
 * - BRC-100 HTTP bridge (ports 3321/2121)
 * - Device peer LAN server (port 3340)
 * - BRC-39 history backup sync
 * - Diagnostic log upload
 */
import { durableGetItem, durableRemoveItem, durableSetItem } from './durableStorage'

const KEY = 'handcash.network.disabled'

export function isNetworkDisabled(): boolean {
  const stored = durableGetItem(KEY)
  return stored === 'true'
}

export function setNetworkDisabled(disabled: boolean): void {
  if (disabled) {
    durableSetItem(KEY, 'true')
  } else {
    durableRemoveItem(KEY)
  }
}