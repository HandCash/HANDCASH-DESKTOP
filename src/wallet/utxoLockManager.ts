/**
 * Optimistic UTXO soft-lock manager.
 *
 * On send: soft-lock inputs → deduct from optimistic balance view.
 * On hard failure: roll back to UNSPENT.
 * On SPV-mined: promote to SPENT_CONFIRMED.
 */
import { durableGetItem, durableSetItem } from './durableStorage'
import {
  canTransitionUtxo,
  makeUtxoLock,
  type UtxoLockRecord,
  type UtxoStatus,
} from './utxoLifecycle'
import { normalizeOutpointKey } from './txLifecycle'

const KEY = 'handcash.wallet.utxoLocks.v1'
const MAX_ENTRIES = 2_000

type Listener = (locks: UtxoLockRecord[]) => void

const listeners = new Set<Listener>()
let cache: Map<string, UtxoLockRecord> | null = null

function load(): Map<string, UtxoLockRecord> {
  if (cache) return cache
  cache = new Map()
  try {
    const raw = durableGetItem(KEY)
    if (!raw) return cache
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return cache
    for (const row of parsed) {
      const rec = coerce(row)
      if (rec) cache.set(rec.outpoint, rec)
    }
  } catch {
    // ignore
  }
  return cache
}

function coerce(row: unknown): UtxoLockRecord | null {
  if (!row || typeof row !== 'object') return null
  const r = row as Record<string, unknown>
  if (typeof r.outpoint !== 'string') return null
  const status = r.status as UtxoStatus
  if (
    status !== 'UNSPENT' &&
    status !== 'SOFT_LOCKED_PENDING' &&
    status !== 'SPENT_CONFIRMED' &&
    status !== 'FROZEN_ERROR'
  ) {
    return null
  }
  return {
    outpoint: normalizeOutpointKey(r.outpoint),
    status,
    lockOwnerId: typeof r.lockOwnerId === 'string' ? r.lockOwnerId : null,
    satoshis: Math.max(0, Math.trunc(Number(r.satoshis) || 0)),
    diagnostic: typeof r.diagnostic === 'string' ? r.diagnostic : null,
    lockedAt: typeof r.lockedAt === 'number' ? r.lockedAt : Date.now(),
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : Date.now(),
  }
}

function persist(): void {
  const map = load()
  const rows = [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  while (rows.length > MAX_ENTRIES) {
    const drop = rows.pop()
    if (drop && drop.status === 'SPENT_CONFIRMED') map.delete(drop.outpoint)
    else if (drop) break
  }
  durableSetItem(KEY, JSON.stringify([...map.values()]))
  for (const listener of listeners) listener([...map.values()])
}

function setStatus(
  outpoint: string,
  to: UtxoStatus,
  patch?: Partial<Pick<UtxoLockRecord, 'lockOwnerId' | 'diagnostic' | 'satoshis'>>,
): UtxoLockRecord | null {
  const map = load()
  const key = normalizeOutpointKey(outpoint)
  const cur = map.get(key)
  if (!cur) return null
  if (!canTransitionUtxo(cur.status, to)) {
    console.warn('[utxo-lock] illegal transition', cur.status, '→', to, key)
    return null
  }
  const next: UtxoLockRecord = {
    ...cur,
    ...patch,
    status: to,
    updatedAt: Date.now(),
  }
  map.set(key, next)
  persist()
  return next
}

export function listUtxoLocks(): UtxoLockRecord[] {
  return [...load().values()]
}

export function getUtxoLock(outpoint: string): UtxoLockRecord | null {
  return load().get(normalizeOutpointKey(outpoint)) ?? null
}

export function subscribeUtxoLocks(listener: Listener): () => void {
  listeners.add(listener)
  listener(listUtxoLocks())
  return () => {
    listeners.delete(listener)
  }
}

/** Soft-lock inputs for a draft tx. Fails closed if any input already locked/spent. */
export function softLockInputs(args: {
  lockOwnerId: string
  inputs: Array<{ outpoint: string; satoshis: number }>
}): { ok: true; locks: UtxoLockRecord[] } | { ok: false; reason: string } {
  const map = load()
  const prepared: UtxoLockRecord[] = []
  for (const input of args.inputs) {
    const key = normalizeOutpointKey(input.outpoint)
    const existing = map.get(key)
    if (existing) {
      if (
        existing.status === 'SOFT_LOCKED_PENDING' &&
        existing.lockOwnerId !== args.lockOwnerId
      ) {
        return { ok: false, reason: `UTXO already soft-locked: ${key}` }
      }
      if (existing.status === 'SPENT_CONFIRMED') {
        return { ok: false, reason: `UTXO already spent: ${key}` }
      }
      if (existing.status === 'FROZEN_ERROR') {
        return { ok: false, reason: `UTXO frozen: ${key}` }
      }
    }
    prepared.push(
      makeUtxoLock({
        outpoint: key,
        satoshis: input.satoshis,
        lockOwnerId: args.lockOwnerId,
      }),
    )
  }

  for (const lock of prepared) {
    map.set(lock.outpoint, lock)
  }
  persist()
  return { ok: true, locks: prepared }
}

/** Roll back soft-locks owned by this draft (REJECTED / validation fail). */
export function rollbackLocks(lockOwnerId: string): number {
  const map = load()
  let n = 0
  for (const [key, rec] of map) {
    if (rec.lockOwnerId === lockOwnerId && rec.status === 'SOFT_LOCKED_PENDING') {
      map.set(key, {
        ...rec,
        status: 'UNSPENT',
        lockOwnerId: null,
        diagnostic: null,
        updatedAt: Date.now(),
      })
      n += 1
    }
  }
  if (n > 0) persist()
  return n
}

/** Promote soft-locks to confirmed spent after SPV-mined. */
export function confirmSpentLocks(lockOwnerId: string): number {
  const map = load()
  let n = 0
  for (const [key, rec] of map) {
    if (rec.lockOwnerId === lockOwnerId && rec.status === 'SOFT_LOCKED_PENDING') {
      if (!canTransitionUtxo(rec.status, 'SPENT_CONFIRMED')) continue
      map.set(key, {
        ...rec,
        status: 'SPENT_CONFIRMED',
        updatedAt: Date.now(),
      })
      n += 1
    }
  }
  if (n > 0) persist()
  return n
}

/** Freeze a UTXO after an ambiguous error — reconcile may thaw. */
export function freezeUtxo(outpoint: string, diagnostic: string): UtxoLockRecord | null {
  const map = load()
  const key = normalizeOutpointKey(outpoint)
  const cur = map.get(key)
  if (!cur) {
    const now = Date.now()
    const rec: UtxoLockRecord = {
      outpoint: key,
      status: 'FROZEN_ERROR',
      lockOwnerId: null,
      satoshis: 0,
      diagnostic,
      lockedAt: now,
      updatedAt: now,
    }
    map.set(key, rec)
    persist()
    return rec
  }
  return setStatus(key, 'FROZEN_ERROR', { diagnostic, lockOwnerId: null })
}

export function thawUtxo(outpoint: string): UtxoLockRecord | null {
  return setStatus(outpoint, 'UNSPENT', { diagnostic: null, lockOwnerId: null })
}

/** Soft-locked sats subtracted from optimistic balance view. */
export function softLockedSatsTotal(): number {
  let sum = 0
  for (const rec of load().values()) {
    if (rec.status === 'SOFT_LOCKED_PENDING') sum += rec.satoshis
  }
  return sum
}

/**
 * Optimistic spendable = toolbox spendable − soft-locked.
 * Never uses floats; both sides are integer sats.
 */
export function optimisticSpendableSats(toolboxSpendableSats: number): number {
  const base = Math.max(0, Math.trunc(toolboxSpendableSats))
  return Math.max(0, base - softLockedSatsTotal())
}

export function __resetUtxoLocksForTests(): void {
  cache = new Map()
  durableSetItem(KEY, '[]')
}
