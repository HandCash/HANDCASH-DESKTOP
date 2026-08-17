/**
 * Optimistic UTXO overlay (Cloud `spentStatus` names).
 *
 * On send: `selected` → deduct from optimistic balance.
 * On hard failure that did not spend: roll back to `available`.
 * On broadcast accept / already-spent: `spent` (hidden, row kept).
 * On ambiguous error: `quarantine` (hidden until thaw).
 */
import { durableGetItem, durableSetItem } from './durableStorage'
import {
  canTransitionUtxo,
  coerceUtxoStatus,
  isHiddenFromSpend,
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
  const status = coerceUtxoStatus(r.status)
  if (!status) return null
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
  // Cap only by dropping oldest *spent* overlay rows. Toolbox still has them;
  // we never delete a coin, only forget the hide hint after the cap.
  while (rows.length > MAX_ENTRIES) {
    const drop = rows.pop()
    if (drop && drop.status === 'spent') map.delete(drop.outpoint)
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

/**
 * Upsert overlay status. `spent` / `quarantine` always succeed (hide without
 * deleting). `available` will not unhide a `spent` coin.
 */
export function upsertUtxoStatus(
  outpoint: string,
  to: UtxoStatus,
  patch?: Partial<Pick<UtxoLockRecord, 'lockOwnerId' | 'diagnostic' | 'satoshis'>>,
): UtxoLockRecord {
  const map = load()
  const key = normalizeOutpointKey(outpoint)
  const cur = map.get(key)
  const now = Date.now()
  if (!cur) {
    const rec: UtxoLockRecord = {
      outpoint: key,
      status: to,
      lockOwnerId: patch?.lockOwnerId ?? null,
      satoshis: Math.max(0, Math.trunc(Number(patch?.satoshis) || 0)),
      diagnostic: patch?.diagnostic ?? null,
      lockedAt: now,
      updatedAt: now,
    }
    map.set(key, rec)
    persist()
    return rec
  }
  if (to === 'available' && cur.status === 'spent') return cur
  if (to !== cur.status && !canTransitionUtxo(cur.status, to) && to !== 'spent') {
    console.warn('[utxo-lock] illegal transition', cur.status, '→', to, key)
    return cur
  }
  const next: UtxoLockRecord = {
    ...cur,
    ...patch,
    status: to,
    updatedAt: now,
  }
  map.set(key, next)
  persist()
  return next
}

/** Hide a coin (`spent` or `quarantine`) without deleting the toolbox row. */
export function hideUtxo(
  outpoint: string,
  as: 'spent' | 'quarantine',
  opts?: { satoshis?: number; diagnostic?: string },
): UtxoLockRecord {
  return upsertUtxoStatus(outpoint, as, {
    lockOwnerId: null,
    satoshis: opts?.satoshis,
    diagnostic: opts?.diagnostic ?? null,
  })
}

/** Re-offer a quarantined coin. Spent coins stay hidden. */
export function creditUtxo(
  outpoint: string,
  opts?: { satoshis?: number },
): UtxoLockRecord | null {
  const cur = getUtxoLock(outpoint)
  if (cur?.status === 'spent') return cur
  return upsertUtxoStatus(outpoint, 'available', {
    lockOwnerId: null,
    diagnostic: null,
    satoshis: opts?.satoshis,
  })
}

export function listUtxoLocks(): UtxoLockRecord[] {
  return [...load().values()]
}

export function getUtxoLock(outpoint: string): UtxoLockRecord | null {
  return load().get(normalizeOutpointKey(outpoint)) ?? null
}

/** Restore / Pay must not resurrect hidden or in-flight coins. */
export function isUtxoBlockedFromRestore(outpoint: string): boolean {
  const rec = getUtxoLock(outpoint)
  return rec ? isHiddenFromSpend(rec.status) : false
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
        existing.status === 'selected' &&
        existing.lockOwnerId !== args.lockOwnerId
      ) {
        return { ok: false, reason: `UTXO already soft-locked: ${key}` }
      }
      if (existing.status === 'spent') {
        return { ok: false, reason: `UTXO already spent: ${key}` }
      }
      if (existing.status === 'quarantine') {
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

/** Roll back `selected` locks owned by this draft (REJECTED / validation fail). */
export function rollbackLocks(lockOwnerId: string): number {
  const map = load()
  let n = 0
  for (const [key, rec] of map) {
    if (rec.lockOwnerId === lockOwnerId && rec.status === 'selected') {
      map.set(key, {
        ...rec,
        status: 'available',
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

/** Hide this draft's inputs as `spent` after mempool accept or already-spent. */
export function confirmSpentLocks(lockOwnerId: string): number {
  const map = load()
  let n = 0
  for (const [key, rec] of map) {
    if (rec.lockOwnerId === lockOwnerId && rec.status === 'selected') {
      if (!canTransitionUtxo(rec.status, 'spent')) continue
      map.set(key, {
        ...rec,
        status: 'spent',
        updatedAt: Date.now(),
      })
      n += 1
    }
  }
  if (n > 0) persist()
  return n
}

/** Freeze a UTXO after an ambiguous error — reconcile may thaw. */
export function freezeUtxo(outpoint: string, diagnostic: string): UtxoLockRecord {
  return hideUtxo(outpoint, 'quarantine', { diagnostic })
}

export function thawUtxo(outpoint: string): UtxoLockRecord | null {
  const cur = getUtxoLock(outpoint)
  if (cur?.status === 'spent') return cur
  return setStatus(outpoint, 'available', { diagnostic: null, lockOwnerId: null })
    ?? creditUtxo(outpoint)
}

/** Soft-locked sats subtracted from optimistic balance view. */
export function softLockedSatsTotal(): number {
  let sum = 0
  for (const rec of load().values()) {
    if (rec.status === 'selected') sum += rec.satoshis
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
