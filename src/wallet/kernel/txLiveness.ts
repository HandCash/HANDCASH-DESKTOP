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
  'nonfinal',
  'unfail',
  'unmined',
  'callback',
  'unconfirmed',
  'unknown',
] as const)

const liveStatuses: ReadonlySet<string> = new Set(LIVE_LOCAL_TX_STATUSES)

export type TxLiveness = 'pending' | 'settled' | 'dead' | 'none'

/** True when a local transaction is still this wallet's spend. */
export function isLiveLocalTxStatus(status: unknown): boolean {
  return liveStatuses.has(String(status ?? '').toLowerCase())
}

export function txLivenessFromStatus(status: unknown): TxLiveness {
  const normalized = String(status ?? '').toLowerCase()
  if (!normalized) return 'none'
  if (normalized === 'completed') return 'settled'
  return isLiveLocalTxStatus(normalized) ? 'pending' : 'dead'
}
