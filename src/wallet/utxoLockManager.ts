/**
 * Optimistic UTXO overlay (BRC-38 `spendable` / `spentBy`).
 *
 * On send: reserve (`lockOwnerId`) → deduct from optimistic balance.
 * On hard failure that did not spend: clear reservation (`spendable: true`).
 * On broadcast accept / already-spent: `spendable: false` + `spentBy`.
 * On ambiguous error: `spendable: false` with no `spentBy` (hidden until thaw).
 */
import { durableGetItem, durableSetItem } from './durableStorage'
import {
  canMarkSpendable,
  coerceUtxoLock,
  isConsumed,
  isHiddenFromSpend,
  isReserved,
  isUnspendable,
  makeUtxoLock,
  type UtxoLockRecord,
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
      const rec = coerceUtxoLock(row)
      if (rec) cache.set(rec.outpoint, rec)
    }
  } catch {
    // ignore
  }
  return cache
}

function persist(): void {
  const map = load()
  const rows = [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  // Cap only by dropping oldest consumed overlay rows. Toolbox still has them;
  // we never delete a coin, only forget the hide hint after the cap.
  while (rows.length > MAX_ENTRIES) {
    const drop = rows.pop()
    if (drop && isConsumed(drop)) map.delete(drop.outpoint)
    else if (drop) break
  }
  durableSetItem(KEY, JSON.stringify([...map.values()]))
  for (const listener of listeners) listener([...map.values()])
}

function put(rec: UtxoLockRecord): UtxoLockRecord {
  const map = load()
  map.set(rec.outpoint, rec)
  persist()
  return rec
}

/**
 * Upsert overlay. Consumed (`spentBy` set) cannot become spendable and
 * cannot have `spentBy` cleared.
 */
export function upsertUtxoLock(
  outpoint: string,
  patch: Partial<Pick<UtxoLockRecord, 'spendable' | 'spentBy' | 'lockOwnerId' | 'diagnostic' | 'satoshis'>>,
): UtxoLockRecord {
  const map = load()
  const key = normalizeOutpointKey(outpoint)
  const cur = map.get(key)
  const now = Date.now()
  if (cur && isConsumed(cur) && (patch.spendable === true || patch.spentBy === null)) {
    return cur
  }
  const nextSpentBy = patch.spentBy !== undefined ? patch.spentBy : cur?.spentBy ?? null

  const rec: UtxoLockRecord = {
    outpoint: key,
    spendable: nextSpentBy != null ? false : asBool(patch.spendable, cur?.spendable ?? true),
    spentBy: nextSpentBy,
    lockOwnerId: nextSpentBy != null ? null : patch.lockOwnerId !== undefined ? patch.lockOwnerId : cur?.lockOwnerId ?? null,
    satoshis: Math.max(0, Math.trunc(Number(patch.satoshis ?? cur?.satoshis) || 0)),
    diagnostic: patch.diagnostic !== undefined ? patch.diagnostic : cur?.diagnostic ?? null,
    lockedAt: cur?.lockedAt ?? now,
    updatedAt: now,
  }
  return put(rec)
}

function asBool(v: boolean | undefined, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

/** Hide a coin without deleting the toolbox row (BRC-38 `spendable: false`). */
export function hideUtxo(
  outpoint: string,
  opts?: {
    /** BRC-38 spender txid when known. Pass `''` when spent by an unknown tx. Omit to freeze (thawable). */
    spentBy?: string | null
    satoshis?: number
    diagnostic?: string
  },
): UtxoLockRecord {
  const consumed = opts?.spentBy !== undefined && opts.spentBy !== null
  return upsertUtxoLock(outpoint, {
    spendable: false,
    spentBy: consumed ? (opts?.spentBy ?? '') : null,
    lockOwnerId: null,
    satoshis: opts?.satoshis,
    diagnostic: opts?.diagnostic ?? null,
  })
}

/** Re-offer an unspendable coin. Consumed coins stay hidden. */
export function creditUtxo(
  outpoint: string,
  opts?: { satoshis?: number },
): UtxoLockRecord | null {
  const cur = getUtxoLock(outpoint)
  if (cur && isConsumed(cur)) return cur
  return upsertUtxoLock(outpoint, {
    spendable: true,
    spentBy: null,
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
  return rec ? isHiddenFromSpend(rec) : false
}

export function subscribeUtxoLocks(listener: Listener): () => void {
  listeners.add(listener)
  listener(listUtxoLocks())
  return () => {
    listeners.delete(listener)
  }
}

/** Reserve inputs for a draft tx. Fails closed if any input already reserved/spent. */
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
      if (isReserved(existing) && existing.lockOwnerId !== args.lockOwnerId) {
        return { ok: false, reason: `UTXO already reserved: ${key}` }
      }
      if (isConsumed(existing)) {
        return { ok: false, reason: `UTXO already spent: ${key}` }
      }
      if (isUnspendable(existing)) {
        return { ok: false, reason: `UTXO not spendable: ${key}` }
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

/** Roll back reservations owned by this draft (REJECTED / validation fail). */
export function rollbackLocks(lockOwnerId: string): number {
  const map = load()
  let n = 0
  for (const [key, rec] of map) {
    if (isReserved(rec) && rec.lockOwnerId === lockOwnerId) {
      map.set(key, {
        ...rec,
        spendable: true,
        spentBy: null,
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

/** Hide this draft's inputs as consumed after mempool accept or already-spent. */
export function confirmSpentLocks(lockOwnerId: string, spentBy?: string | null): number {
  const map = load()
  let n = 0
  const spender = spentBy ?? ''
  for (const [key, rec] of map) {
    if (!isReserved(rec) || rec.lockOwnerId !== lockOwnerId) continue
    map.set(key, {
      ...rec,
      spendable: false,
      spentBy: spender,
      lockOwnerId: null,
      updatedAt: Date.now(),
    })
    n += 1
  }
  if (n > 0) persist()
  return n
}

/** Freeze a UTXO after an ambiguous error — reconcile may thaw. */
export function freezeUtxo(outpoint: string, diagnostic: string): UtxoLockRecord {
  return hideUtxo(outpoint, { diagnostic })
}

export function thawUtxo(outpoint: string): UtxoLockRecord | null {
  const cur = getUtxoLock(outpoint)
  if (cur && isConsumed(cur)) return cur
  if (cur && !canMarkSpendable(cur)) return cur
  return upsertUtxoLock(outpoint, {
    spendable: true,
    spentBy: null,
    diagnostic: null,
    lockOwnerId: null,
  })
}

/** Reserved sats subtracted from optimistic balance view. */
export function softLockedSatsTotal(): number {
  let sum = 0
  for (const rec of load().values()) {
    if (isReserved(rec)) sum += rec.satoshis
  }
  return sum
}

/**
 * Optimistic spendable = toolbox spendable − reserved.
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
