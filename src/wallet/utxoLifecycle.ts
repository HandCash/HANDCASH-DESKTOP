/**
 * UTXO lifecycle for the optimistic layer.
 *
 * Soft-locks happen *before* ARC dispatch so the UI balance can deduct
 * immediately. Hard failures roll locks back to UNSPENT. Confirmed spends
 * move to SPENT_CONFIRMED. FROZEN_ERROR is fail-closed until thaw / reconcile.
 */

import { normalizeOutpointKey } from './txLifecycle'

export type UtxoStatus =
  | 'UNSPENT'
  | 'SOFT_LOCKED_PENDING'
  | 'SPENT_CONFIRMED'
  | 'FROZEN_ERROR'

export type UtxoLockRecord = {
  outpoint: string
  status: UtxoStatus
  /** Tx draft / pending id that holds the soft-lock. */
  lockOwnerId: string | null
  satoshis: number
  diagnostic: string | null
  lockedAt: number
  updatedAt: number
}

const UTXO_FORWARD: Readonly<Record<UtxoStatus, ReadonlySet<UtxoStatus>>> = {
  UNSPENT: new Set(['SOFT_LOCKED_PENDING', 'FROZEN_ERROR']),
  SOFT_LOCKED_PENDING: new Set(['UNSPENT', 'SPENT_CONFIRMED', 'FROZEN_ERROR']),
  SPENT_CONFIRMED: new Set([]),
  FROZEN_ERROR: new Set(['UNSPENT', 'SOFT_LOCKED_PENDING']),
}

export function canTransitionUtxo(from: UtxoStatus, to: UtxoStatus): boolean {
  if (from === to) return true
  return UTXO_FORWARD[from]?.has(to) ?? false
}

export function isSoftLocked(status: UtxoStatus): boolean {
  return status === 'SOFT_LOCKED_PENDING'
}

export function countsTowardSpendable(status: UtxoStatus): boolean {
  return status === 'UNSPENT'
}

export function makeUtxoLock(args: {
  outpoint: string
  satoshis: number
  lockOwnerId: string
  now?: number
}): UtxoLockRecord {
  const now = args.now ?? Date.now()
  return {
    outpoint: normalizeOutpointKey(args.outpoint),
    status: 'SOFT_LOCKED_PENDING',
    lockOwnerId: args.lockOwnerId,
    satoshis: Math.max(0, Math.trunc(args.satoshis)),
    diagnostic: null,
    lockedAt: now,
    updatedAt: now,
  }
}
