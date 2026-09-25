/**
 * Optimistic UTXO overlay (BRC-38 `spendable` / `spentBy`).
 *
 * On send: reserve (`lockOwnerId`) → deduct from optimistic balance.
 * On hard failure that did not spend: clear reservation (`spendable: true`).
 * On broadcast accept / already-spent: `spendable: false` + `spentBy`.
 * On ambiguous error: `spendable: false` with no `spentBy` (hidden until thaw).
 */
import { durableGetItem, durableSetItem } from "./durableStorage";
import { accountLocalKey } from "./accountLocalKeys";
import { storageRegistry } from "../storage/registry";
import {
  canMarkSpendable,
  coerceUtxoLock,
  isConsumed,
  isQuarantined,
  isReserved,
  isUnspendable,
  makeUtxoLock,
  type UtxoLockRecord,
} from "./utxoLifecycle";
import { normalizeOutpointKey } from "./txLifecycle";

const KEY_BASE = storageRegistry.utxoLocks.key;
const MAX_ENTRIES = 2_000;

type Listener = (locks: UtxoLockRecord[]) => void;

const listeners = new Set<Listener>();
let cache: Map<string, UtxoLockRecord> | null = null;

function storageKey(): string {
  return accountLocalKey(KEY_BASE);
}

function load(): Map<string, UtxoLockRecord> {
  if (cache) return cache;
  cache = new Map();
  try {
    const raw = durableGetItem(storageKey());
    if (!raw) return cache;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return cache;
    for (const row of parsed) {
      const rec = coerceUtxoLock(row);
      if (rec) cache.set(rec.outpoint, rec);
    }
  } catch {
    // ignore
  }
  return cache;
}

/** Key the pending write belongs to, or `null` when the overlay is clean. */
let dirtyKey: string | null = null;
let flushQueued = false;

/**
 * Mark the overlay changed; the durable write is coalesced to one per task.
 *
 * Serializing the whole overlay and paying a synchronous `localStorage.setItem`
 * per coin is what froze the app: sealing a transaction calls this once per
 * input, so a bulk seal during unlock recompose held the main thread for
 * seconds at a time (lab phone hc-a580a: 4s tasks, 90% duty, for over a minute).
 * A microtask flush runs once the current task unwinds — before any `await` in
 * the caller resumes — so N coins cost one write and durability is unchanged.
 */
function persist(): void {
  dirtyKey = storageKey();
  if (flushQueued) return;
  flushQueued = true;
  queueMicrotask(flushUtxoLocks);
}

/**
 * Write the overlay now.
 *
 * Runs on its own at the end of the task that mutated the overlay. Reads never
 * wait for it — {@link load} is the live map — so callers only need this where
 * the process may not survive that long.
 */
export function flushUtxoLocks(): void {
  flushQueued = false;
  const key = dirtyKey;
  if (key == null) return;
  dirtyKey = null;
  // An account switch between mutation and flush would write these rows under
  // the new account's key. The incoming overlay is already durable; drop ours.
  if (key !== storageKey()) return;

  const map = load();
  if (map.size > MAX_ENTRIES) {
    // Cap only by dropping oldest consumed overlay rows. Toolbox still has them;
    // we never delete a coin, only forget the hide hint after the cap.
    const ordered = [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    while (ordered.length > MAX_ENTRIES) {
      const drop = ordered.pop();
      if (drop && isConsumed(drop)) map.delete(drop.outpoint);
      else if (drop) break;
    }
  }
  const rows = [...map.values()];
  durableSetItem(key, JSON.stringify(rows));
  for (const listener of listeners) listener(rows);
}

function put(rec: UtxoLockRecord): UtxoLockRecord {
  const map = load();
  map.set(rec.outpoint, rec);
  persist();
  return rec;
}

/**
 * Upsert overlay. Consumed (`spentBy` set) cannot become spendable and
 * cannot have `spentBy` cleared.
 */
export function upsertUtxoLock(
  outpoint: string,
  patch: Partial<
    Pick<
      UtxoLockRecord,
      "spendable" | "spentBy" | "lockOwnerId" | "diagnostic" | "satoshis"
    >
  >
): UtxoLockRecord {
  const map = load();
  const key = normalizeOutpointKey(outpoint);
  const cur = map.get(key);
  const now = Date.now();
  if (
    cur &&
    isConsumed(cur) &&
    (patch.spendable === true || patch.spentBy === null)
  ) {
    return cur;
  }
  const nextSpentBy =
    patch.spentBy !== undefined ? patch.spentBy : cur?.spentBy ?? null;

  const rec: UtxoLockRecord = {
    outpoint: key,
    spendable:
      nextSpentBy != null
        ? false
        : asBool(patch.spendable, cur?.spendable ?? true),
    spentBy: nextSpentBy,
    lockOwnerId:
      nextSpentBy != null
        ? null
        : patch.lockOwnerId !== undefined
        ? patch.lockOwnerId
        : cur?.lockOwnerId ?? null,
    satoshis: Math.max(
      0,
      Math.trunc(Number(patch.satoshis ?? cur?.satoshis) || 0)
    ),
    diagnostic:
      patch.diagnostic !== undefined
        ? patch.diagnostic
        : cur?.diagnostic ?? null,
    lockedAt: cur?.lockedAt ?? now,
    updatedAt: now,
  };
  return put(rec);
}

function asBool(v: boolean | undefined, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/**
 * Bumped whenever a coin becomes spendable again.
 *
 * Callers that memoize "these inputs are already sealed" must re-check this
 * before trusting the memo — an un-seal is exactly the event that makes a
 * skipped re-seal turn into a reselected, already-spent input.
 */
let unsealGeneration = 0;

export function utxoUnsealGeneration(): number {
  return unsealGeneration;
}

/** Hide a coin without deleting the toolbox row (BRC-38 `spendable: false`). */
export function hideUtxo(
  outpoint: string,
  opts?: {
    /** Named 64-hex spender. Omit for freeze/quarantine — never invent `spentBy: ''`. */
    spentBy?: string | null;
    satoshis?: number;
    diagnostic?: string;
  }
): UtxoLockRecord {
  const consumed = opts?.spentBy !== undefined && opts.spentBy !== null;
  return upsertUtxoLock(outpoint, {
    spendable: false,
    spentBy: consumed ? opts?.spentBy ?? "" : null,
    lockOwnerId: null,
    satoshis: opts?.satoshis,
    diagnostic: opts?.diagnostic ?? null,
  });
}

/**
 * Un-seal a coin we retired for a transaction that never reached a node.
 *
 * The spend path seals inputs the moment `createAction` signs, so a burst of
 * sends cannot reselect them. When the broadcast then fails without anybody
 * reachable saying the input is gone, that seal is bookkeeping for a
 * transaction that does not exist, and leaving it in place quietly removes the
 * coin from spendable balance for good — `upsertUtxoLock` treats `spentBy` as
 * terminal precisely so a stray restore cannot resurrect a real spend.
 *
 * Only call this with the inputs of a signed transaction known not to have
 * broadcast. Chain ingest re-hides anything the indexer later reports spent.
 */
export function releaseConsumedUtxo(
  outpoint: string,
  diagnostic: string
): UtxoLockRecord | null {
  const key = normalizeOutpointKey(outpoint);
  const cur = load().get(key);
  if (!cur) return null;
  const now = Date.now();
  unsealGeneration += 1;
  return put({
    ...cur,
    spendable: true,
    spentBy: null,
    lockOwnerId: null,
    diagnostic,
    updatedAt: now,
  });
}

/** Re-offer an unspendable coin. Consumed coins stay hidden. */
export function creditUtxo(
  outpoint: string,
  opts?: { satoshis?: number }
): UtxoLockRecord | null {
  const cur = getUtxoLock(outpoint);
  if (cur && isConsumed(cur)) return cur;
  // Only a true revive must bump {@link utxoUnsealGeneration}. Crediting a
  // brand-new change outpoint (or re-touching an already-spendable row) used
  // to invalidate the seal/promote memo on every createAction — lab phone
  // hc-a580a re-sealed the same txid 16× in a few seconds and stalled the
  // renderer while permission prompts waited to paint.
  const revivedUnspendable = cur != null && isUnspendable(cur);
  const next = upsertUtxoLock(outpoint, {
    spendable: true,
    spentBy: null,
    lockOwnerId: null,
    diagnostic: null,
    satoshis: opts?.satoshis,
  });
  if (revivedUnspendable) unsealGeneration += 1;
  return next;
}

export function listUtxoLocks(): UtxoLockRecord[] {
  return [...load().values()];
}

export function getUtxoLock(outpoint: string): UtxoLockRecord | null {
  return load().get(normalizeOutpointKey(outpoint)) ?? null;
}

/** Restore must not resurrect reserved or consumed coins. Quarantine may thaw on unspent proof. */
export function isUtxoBlockedFromRestore(outpoint: string): boolean {
  const rec = getUtxoLock(outpoint);
  if (!rec) return false;
  return isConsumed(rec) || isReserved(rec);
}

export function subscribeUtxoLocks(listener: Listener): () => void {
  listeners.add(listener);
  listener(listUtxoLocks());
  return () => {
    listeners.delete(listener);
  };
}

export function rebindUtxoLocksForAccount(): void {
  // Land any coalesced write for the outgoing account before its map is gone.
  flushUtxoLocks();
  cache = null;
  unsealGeneration = 0;
  const rows = listUtxoLocks();
  for (const listener of listeners) listener(rows);
}

/** Reserve inputs for a draft tx. Fails closed if any input already reserved/spent. */
export function softLockInputs(args: {
  lockOwnerId: string;
  inputs: Array<{ outpoint: string; satoshis: number }>;
}): { ok: true; locks: UtxoLockRecord[] } | { ok: false; reason: string } {
  const map = load();
  const prepared: UtxoLockRecord[] = [];
  for (const input of args.inputs) {
    const key = normalizeOutpointKey(input.outpoint);
    const existing = map.get(key);
    if (existing) {
      if (isReserved(existing) && existing.lockOwnerId !== args.lockOwnerId) {
        return { ok: false, reason: `UTXO already reserved: ${key}` };
      }
      if (isConsumed(existing)) {
        return { ok: false, reason: `UTXO already spent: ${key}` };
      }
      if (isUnspendable(existing)) {
        return { ok: false, reason: `UTXO not spendable: ${key}` };
      }
    }
    prepared.push(
      makeUtxoLock({
        outpoint: key,
        satoshis: input.satoshis,
        lockOwnerId: args.lockOwnerId,
      })
    );
  }

  for (const lock of prepared) {
    map.set(lock.outpoint, lock);
  }
  persist();
  return { ok: true, locks: prepared };
}

/** Roll back reservations owned by this draft (REJECTED / validation fail). */
export function rollbackLocks(lockOwnerId: string): number {
  const map = load();
  let n = 0;
  for (const [key, rec] of map) {
    if (isReserved(rec) && rec.lockOwnerId === lockOwnerId) {
      map.set(key, {
        ...rec,
        spendable: true,
        spentBy: null,
        lockOwnerId: null,
        diagnostic: null,
        updatedAt: Date.now(),
      });
      n += 1;
    }
  }
  if (n > 0) persist();
  return n;
}

/** Hide this draft's inputs as consumed after mempool accept or already-spent. */
export function confirmSpentLocks(
  lockOwnerId: string,
  spentBy?: string | null
): number {
  const map = load();
  let n = 0;
  const spender = String(spentBy ?? "")
    .trim()
    .toLowerCase();
  const named = /^[0-9a-f]{64}$/.test(spender) ? spender : null;
  for (const [key, rec] of map) {
    if (!isReserved(rec) || rec.lockOwnerId !== lockOwnerId) continue;
    map.set(key, {
      ...rec,
      spendable: false,
      spentBy: named,
      lockOwnerId: null,
      diagnostic: named ? rec.diagnostic : "quarantine:spent-unknown",
      updatedAt: Date.now(),
    });
    n += 1;
  }
  if (n > 0) persist();
  return n;
}

/** Draft reservation TTL — Cloud `selected` leaked forever without this. */
export const UTXO_RESERVATION_TTL_MS = 15 * 60_000;

/**
 * Clear overlay reservations that never became a signed transaction.
 * Live dual-layer / pending-send owner ids stay reserved.
 */
export function expireStaleUtxoReservations(args?: {
  now?: number;
  liveOwnerIds?: Iterable<string>;
  ttlMs?: number;
}): number {
  const now = args?.now ?? Date.now();
  const ttl = args?.ttlMs ?? UTXO_RESERVATION_TTL_MS;
  const live = new Set(
    [...(args?.liveOwnerIds ?? [])]
      .map((id) => String(id).trim())
      .filter(Boolean)
  );
  const map = load();
  let n = 0;
  for (const [key, rec] of map) {
    if (!isReserved(rec) || !rec.lockOwnerId) continue;
    if (live.has(rec.lockOwnerId)) continue;
    if (now - rec.lockedAt < ttl) continue;
    map.set(key, {
      ...rec,
      spendable: true,
      spentBy: null,
      lockOwnerId: null,
      diagnostic: "reservation-expired",
      updatedAt: now,
    });
    n += 1;
  }
  if (n > 0) persist();
  return n;
}

/** Freeze a UTXO after an ambiguous error — reconcile may thaw. */
export function freezeUtxo(
  outpoint: string,
  diagnostic: string
): UtxoLockRecord {
  return hideUtxo(outpoint, { diagnostic });
}

export function thawUtxo(outpoint: string): UtxoLockRecord | null {
  const cur = getUtxoLock(outpoint);
  if (cur && isConsumed(cur)) return cur;
  if (cur && !canMarkSpendable(cur)) return cur;
  if (cur && isQuarantined(cur)) return cur;
  return upsertUtxoLock(outpoint, {
    spendable: true,
    spentBy: null,
    diagnostic: null,
    lockOwnerId: null,
  });
}

/** Reserved sats subtracted from optimistic balance view. */
export function softLockedSatsTotal(): number {
  let sum = 0;
  for (const rec of load().values()) {
    if (isReserved(rec)) sum += rec.satoshis;
  }
  return sum;
}

/**
 * Optimistic spendable = toolbox spendable − reserved.
 * Never uses floats; both sides are integer sats.
 */
export function optimisticSpendableSats(toolboxSpendableSats: number): number {
  const base = Math.max(0, Math.trunc(toolboxSpendableSats));
  return Math.max(0, base - softLockedSatsTotal());
}

export function __resetUtxoLocksForTests(): void {
  cache = new Map();
  dirtyKey = null;
  flushQueued = false;
  durableSetItem(storageKey(), "[]");
  unsealGeneration = 0;
}
