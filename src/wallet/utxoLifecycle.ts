/**
 * UTXO overlay — same four statuses as HandCash Cloud `spentStatus`.
 *
 * Toolbox rows stay in storage. We hide a coin by changing status (and
 * `spendable: false`), never by deleting it. Restore / Pay only see
 * `available`.
 *
 * Durable JSON may still hold the pre-1.2.233 names; {@link coerceUtxoStatus}
 * maps those on read.
 */

import { normalizeOutpointKey } from './txLifecycle'

/** Cloud `spentStatus.status` names. */
export type UtxoStatus = 'available' | 'selected' | 'spent' | 'quarantine'

const LEGACY_STATUS: Record<string, UtxoStatus> = {
  UNSPENT: 'available',
  SOFT_LOCKED_PENDING: 'selected',
  SPENT_CONFIRMED: 'spent',
  FROZEN_ERROR: 'quarantine',
  available: 'available',
  selected: 'selected',
  spent: 'spent',
  quarantine: 'quarantine',
}

export function coerceUtxoStatus(raw: unknown): UtxoStatus | null {
  if (typeof raw !== 'string') return null
  return LEGACY_STATUS[raw] ?? null
}

export type UtxoLockRecord = {
  outpoint: string
  status: UtxoStatus
  /** Tx draft / pending id that holds the `selected` reservation. */
  lockOwnerId: string | null
  satoshis: number
  diagnostic: string | null
  lockedAt: number
  updatedAt: number
}

const UTXO_FORWARD: Readonly<Record<UtxoStatus, ReadonlySet<UtxoStatus>>> = {
  available: new Set(['selected', 'quarantine', 'spent']),
  selected: new Set(['available', 'spent', 'quarantine']),
  spent: new Set([]),
  quarantine: new Set(['available', 'selected', 'spent']),
}

export function canTransitionUtxo(from: UtxoStatus, to: UtxoStatus): boolean {
  if (from === to) return true
  return UTXO_FORWARD[from]?.has(to) ?? false
}

export function isSoftLocked(status: UtxoStatus): boolean {
  return status === 'selected'
}

/** True when Pay must not offer this coin. */
export function isHiddenFromSpend(status: UtxoStatus): boolean {
  return status === 'spent' || status === 'quarantine' || status === 'selected'
}

export function countsTowardSpendable(status: UtxoStatus): boolean {
  return status === 'available'
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
    status: 'selected',
    lockOwnerId: args.lockOwnerId,
    satoshis: Math.max(0, Math.trunc(args.satoshis)),
    diagnostic: null,
    lockedAt: now,
    updatedAt: now,
  }
}
