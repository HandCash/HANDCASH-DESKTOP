/**
 * Payment policy: no offline spends.
 */

export function isNetworkOnline(): boolean {
  if (typeof navigator === 'undefined') return true
  return navigator.onLine !== false
}

const OFFLINE_PAYMENT_MESSAGE = 'Offline payments are not supported. Connect to the network to send.'

/**
 * Refuse to start a payment while offline.
 */
export function assertOnlineForPayment(): void {
  if (isNetworkOnline()) return
  throw new Error(OFFLINE_PAYMENT_MESSAGE)
}

export function offlinePaymentBlockedMessage(): string | null {
  return isNetworkOnline() ? null : OFFLINE_PAYMENT_MESSAGE
}
