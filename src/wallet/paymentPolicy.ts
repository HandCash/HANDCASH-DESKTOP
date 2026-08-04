/**
 * Payment policy: no offline spends — especially with multi-device parity.
 * Stale local UTXOs + another device spending = double-spend risk without network.
 */

import { hasDeviceLinkBackupUrl } from './deviceSync'

export function isNetworkOnline(): boolean {
  if (typeof navigator === 'undefined') return true
  return navigator.onLine !== false
}

/** True when this install uses shared BRC-39 device parity. */
export function isDeviceParityEnabled(): boolean {
  return hasDeviceLinkBackupUrl()
}

/**
 * Refuse to start a payment while offline.
 * Device parity does not add offline pay — it makes online sync more important.
 */
export function assertOnlineForPayment(): void {
  if (isNetworkOnline()) return
  if (isDeviceParityEnabled()) {
    throw new Error(
      'Offline payments are not supported with device parity. Go online, Sync via backup URL if needed, then send.',
    )
  }
  throw new Error('Offline payments are not supported. Connect to the network to send.')
}

export function offlinePaymentBlockedMessage(): string | null {
  if (isNetworkOnline()) return null
  return isDeviceParityEnabled()
    ? 'Offline payments are off. Go online (and Sync if you use a shared backup URL) before sending.'
    : 'Offline payments are not supported. Connect to the network to send.'
}
