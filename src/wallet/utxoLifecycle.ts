/**
 * UTXO overlay — BRC-38 output fields (`spendable`, `spentBy`).
 *
 * Toolbox rows stay in storage. We hide a coin by setting `spendable: false`
 * (and `spentBy` when the spender is known), never by deleting it. Restore /
 * Pay only see spendable coins that are not reserved and not consumed.
 *
 * `lockOwnerId` is a wallet-local reservation during send — not a BRC status.
 *
 * Durable JSON from 1.2.233 may still hold Cloud `spentStatus` names;
 * {@link coerceUtxoLock} maps those on read.
 */

import { normalizeOutpointKey } from './txLifecycle'

/** BRC-38 overlay row. `lockOwnerId` is local (in-flight send). */
export type UtxoLockRecord = {
  outpoint: string
  /** BRC-38 `spendable`. */
  spendable: boolean
  /**
   * BRC-38 `spentBy` as the spender txid when known.
   * Non-null (including `''` when the spender id is unknown) means consumed —
   * Refresh must not re-offer this coin. `null` is unspent.
   */
  spentBy: string | null
  /** Tx draft / pending id that holds the reservation. Not a BRC field. */
  lockOwnerId: string | null
  satoshis: number
  diagnostic: string | null
  lockedAt: number
  updatedAt: number
}

const LEGACY_STATUS: Record<string, { spendable: boolean; spentBy: string | null; reserved: boolean }> = {
  UNSPENT: { spendable: true, spentBy: null, reserved: false },
  SOFT_LOCKED_PENDING: { spendable: true, spentBy: null, reserved: true },
  SPENT_CONFIRMED: { spendable: false, spentBy: '', reserved: false },
  FROZEN_ERROR: { spendable: false, spentBy: null, reserved: false },
  available: { spendable: true, spentBy: null, reserved: false },
  selected: { spendable: true, spentBy: null, reserved: true },
  spent: { spendable: false, spentBy: '', reserved: false },
  quarantine: { spendable: false, spentBy: null, reserved: false },
}

function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function asSpentBy(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(Math.trunc(v))
  return null
}

/** Parse overlay JSON (BRC-38 fields or 1.2.233 Cloud names). */
export function coerceUtxoLock(row: unknown): UtxoLockRecord | null {
  if (!row || typeof row !== 'object') return null
  const r = row as Record<string, unknown>
  if (typeof r.outpoint !== 'string') return null

  let spendable: boolean
  let spentBy: string | null
  let lockOwnerId = typeof r.lockOwnerId === 'string' ? r.lockOwnerId : null

  if (typeof r.spendable === 'boolean' || r.spentBy !== undefined) {
    spendable = asBool(r.spendable, r.spentBy == null)
    spentBy = asSpentBy(r.spentBy)
    if (spentBy != null) spendable = false
  } else if (typeof r.status === 'string' && LEGACY_STATUS[r.status]) {
    const mapped = LEGACY_STATUS[r.status]!
    spendable = mapped.spendable
    spentBy = mapped.spentBy
    if (mapped.reserved && !lockOwnerId) {
      spendable = true
      spentBy = null
    }
  } else {
    return null
  }

  return {
    outpoint: normalizeOutpointKey(r.outpoint),
    spendable: spentBy != null ? false : spendable,
    spentBy,
    lockOwnerId: spentBy != null ? null : lockOwnerId,
    satoshis: Math.max(0, Math.trunc(Number(r.satoshis) || 0)),
    diagnostic: typeof r.diagnostic === 'string' ? r.diagnostic : null,
    lockedAt: typeof r.lockedAt === 'number' ? r.lockedAt : Date.now(),
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : Date.now(),
  }
}

/** True when BRC-38 `spentBy` marks the output consumed. */
export function isConsumed(rec: UtxoLockRecord): boolean {
  return rec.spentBy != null
}

/** True when a local send has reserved this coin. */
export function isReserved(rec: UtxoLockRecord): boolean {
  return rec.lockOwnerId != null && rec.spentBy == null
}

/** Hidden without a spender (`spendable: false`, no `spentBy`) — thawable. */
export function isUnspendable(rec: UtxoLockRecord): boolean {
  return !rec.spendable && rec.spentBy == null && rec.lockOwnerId == null
}

/** True when Pay must not offer this coin. */
export function isHiddenFromSpend(rec: UtxoLockRecord): boolean {
  return !rec.spendable || rec.lockOwnerId != null || rec.spentBy != null
}

export function countsTowardSpendable(rec: UtxoLockRecord): boolean {
  return rec.spendable && rec.spentBy == null && rec.lockOwnerId == null
}

/** Consumed coins must not become spendable again. */
export function canMarkSpendable(rec: UtxoLockRecord): boolean {
  return rec.spentBy == null
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
    spendable: true,
    spentBy: null,
    lockOwnerId: args.lockOwnerId,
    satoshis: Math.max(0, Math.trunc(args.satoshis)),
    diagnostic: null,
    lockedAt: now,
    updatedAt: now,
  }
}
