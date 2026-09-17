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

/**
 * Statuses meaning the app still holds the signed tx and no miner has it.
 *
 * `createAction({ noSend: true })` — every `peerDeliver` item settle — parks
 * here. Change of an app-held tx must not feed the next spend, because the app
 * may still abort it. Once Arcade accepts, it is no longer app-held.
 */
export const APP_HELD_TX_STATUSES = Object.freeze(['nosend', 'unsent'] as const)

const appHeldStatuses: ReadonlySet<string> = new Set(APP_HELD_TX_STATUSES)

export type TxLiveness = 'pending' | 'settled' | 'dead' | 'none'

/** True when a local transaction is still this wallet's spend. */
export function isLiveLocalTxStatus(status: unknown): boolean {
  return liveStatuses.has(String(status ?? '').toLowerCase())
}

/** True while the app, not a miner, decides whether this tx lands. */
export function isAppHeldTxStatus(status: unknown): boolean {
  return appHeldStatuses.has(String(status ?? '').toLowerCase())
}

export function txLivenessFromStatus(status: unknown): TxLiveness {
  const normalized = String(status ?? '').toLowerCase()
  if (!normalized) return 'none'
  if (normalized === 'completed') return 'settled'
  return isLiveLocalTxStatus(normalized) ? 'pending' : 'dead'
}
