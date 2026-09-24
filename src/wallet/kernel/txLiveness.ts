/**
 * Pure interpretation of toolbox transaction status.
 *
 * This module deliberately has no session, storage, chain, feature, or UI
 * imports. Balance projection and mutation recovery may both depend on it
 * without depending on each other.
 */
export const LIVE_LOCAL_TX_STATUSES = Object.freeze([
  'sending',
  'unproven',
  'completed',
  'nosend',
  /** Signed `noSend` row still in the miner queue. The cheque is already SPV. */
  'unsent',
  'nonfinal',
  'unfail',
  'unmined',
  'callback',
  'unconfirmed',
  'unknown',
] as const)

const liveStatuses: ReadonlySet<string> = new Set(LIVE_LOCAL_TX_STATUSES)

/**
 * Broadcast-hold: signed, not yet offered to a miner.
 *
 * SPV already owns this cheque (`unconfirmed` / bodies-complete). `nosend` /
 * `unsent` only means we have not cashed it yet — so the next `createAction`
 * must not select its change as a parent Arcade has never seen. Pin ends the
 * hold. It does not create ownership; the signed Atomic BEEF already did.
 */
export const APP_HELD_TX_STATUSES = Object.freeze(['nosend', 'unsent'] as const)

const appHeldStatuses: ReadonlySet<string> = new Set(APP_HELD_TX_STATUSES)

export type TxLiveness = 'pending' | 'settled' | 'dead' | 'none'

/** True when a local transaction is still this wallet's spend. */
export function isLiveLocalTxStatus(status: unknown): boolean {
  return liveStatuses.has(String(status ?? '').toLowerCase())
}

/** True while we are still holding the cheque back from miners. */
export function isAppHeldTxStatus(status: unknown): boolean {
  return appHeldStatuses.has(String(status ?? '').toLowerCase())
}

export function txLivenessFromStatus(status: unknown): TxLiveness {
  const normalized = String(status ?? '').toLowerCase()
  if (!normalized) return 'none'
  if (normalized === 'completed') return 'settled'
  return isLiveLocalTxStatus(normalized) ? 'pending' : 'dead'
}
