/**
 * Payment policy: no offline spends.
 * A shared History backup URL (legacy same-key Sync) makes online reconciliation
 * more important, but linked different-key devices each have their own pot.
 */

import { hasDeviceLinkBackupUrl } from './deviceSync'

export function isNetworkOnline(): boolean {
  if (typeof navigator === 'undefined') return true
  return navigator.onLine !== false
}

/** True when this install has a History backup URL (legacy Sync / spend-lease). */
export function isDeviceParityEnabled(): boolean {
  return hasDeviceLinkBackupUrl()
}

/**
 * Refuse to start a payment while offline.
 */
export function assertOnlineForPayment(): void {
  if (isNetworkOnline()) return
  if (isDeviceParityEnabled()) {
    throw new Error(
      'Offline payments are not supported. Go online, sync History if you use a shared backup URL, then send.',
    )
  }
  throw new Error('Offline payments are not supported. Connect to the network to send.')
}

export function offlinePaymentBlockedMessage(): string | null {
  if (isNetworkOnline()) return null
  return isDeviceParityEnabled()
    ? 'Offline payments are off. Go online (and sync History if you share a backup URL) before sending.'
    : 'Offline payments are not supported. Connect to the network to send.'
}
