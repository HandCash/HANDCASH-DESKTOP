/**
 * Explicit "how many collectables ride one migrate transaction?" vocabulary.
 *
 * One tip per transaction costs a createAction, a signAction and a broadcast
 * round trip each, so a large collection moves at roughly one item per second.
 * Several tips of the same key can share a transaction: same P2PKH item-migrate
 * path, same per-output basket and provenance, fewer round trips.
 *
 * Bundling is a decision, not a fallthrough. A rejected bundle is split by name
 * (`bundleRejected`) and retried as smaller bundles down to singles, so one
 * unspendable tip cannot stall the run — and no other protocol path is ever
 * tried for the same item.
 */
import { Beef } from '@bsv/sdk'

/**
 * Tips per transaction: one import chunk. Each action already carries the
 * chunk's whole input BEEF, so a larger bundle costs no extra download — only
 * one fee, one signing pass and one broadcast where there used to be four.
 */
export const MAX_ITEMS_PER_MIGRATE_TX = 100

/**
 * Bytes one migrate posts to Arcade. Arcade validates Extended Format: the
 * signed transaction plus, per input, the amount and locking script it spends.
 * Parent transactions and BRC-150 ancestry stay on the device — they build the
 * EF and the provenance, never the post — so they are not charged here. Only a
 * never-moved tip is heavy, because its locking script is its inscription.
 */
export const MAX_MIGRATE_POST_BYTES = 1024 * 1024

/** A P2PKH input with a DER signature and compressed key. */
const P2PKH_INPUT_BYTES = 148
/** The tip's 1-sat P2PKH output. */
const P2PKH_OUTPUT_BYTES = 34
const EF_SATOSHIS_BYTES = 8

function varIntBytes(n: number): number {
  if (n < 0xfd) return 1
  if (n <= 0xffff) return 3
  if (n <= 0xffffffff) return 5
  return 9
}

/** EF bytes one tip adds to the post: its input, its output, and the amount and script it spends. */
export function migrateTipPostBytes(sourceLockBytes: number): number {
  return P2PKH_INPUT_BYTES + P2PKH_OUTPUT_BYTES + EF_SATOSHIS_BYTES + varIntBytes(sourceLockBytes) + sourceLockBytes
}

/**
 * How many tips, in page order, fit one post. Every input carries its own
 * spent script, so tips sharing a parent cost the same as tips that do not.
 * Never fewer than one: a tip whose own script exceeds the budget still moves,
 * alone, rather than being stranded.
 */
export function itemsWithinPostBudget<T>(
  items: readonly T[],
  itemsPerTx: number,
  postBytesOf: (item: T) => number,
  budget = MAX_MIGRATE_POST_BYTES,
): number {
  const cap = Math.max(1, Math.min(Math.floor(itemsPerTx), MAX_ITEMS_PER_MIGRATE_TX, items.length))
  let bytes = 0
  let fit = 0
  for (const item of items.slice(0, cap)) {
    const added = postBytesOf(item)
    if (fit > 0 && bytes + added > budget) break
    bytes += added
    fit += 1
  }
  return Math.max(1, fit)
}

/**
 * The signed transaction and only the ancestry it spends. The input BEEF holds
 * every tip of the chunk, so after a bundle is halved most of it belongs to
 * other transactions; shipping it anyway bloated the miner post and the
 * durable retry body. A package the graph cannot be rebuilt from (a txid-only
 * entry) is sent whole rather than refused.
 */
export function migratePackage(packed: Beef, txid: string): number[] {
  try {
    const subject = packed.findAtomicTransaction(txid)
    if (subject) return subject.toAtomicBEEF()
  } catch {
    /* fall back to the whole package */
  }
  return packed.toBinaryAtomic(txid)
}

/**
 * What the archive keeps so a migrate survives the app closing: the signed
 * transaction and every unmined ancestor in full, mined ones by txid. The
 * archive is a 1MB store shared by every unproven cheque, and the mined
 * sources of art-bearing items are most of a package; a retry fetches them
 * back with their proofs. Unmined bodies stay, because nothing can.
 */
export function migrateRetryBody(atomic: number[], txid: string): number[] {
  try {
    const full = Beef.fromBinary(atomic)
    const thin = new Beef()
    for (const btx of full.txs) {
      const raw = btx.rawTx
      if (btx.isTxidOnly || !raw || (btx.txid !== txid && btx.bumpIndex !== undefined)) thin.mergeTxidOnly(btx.txid)
      else thin.mergeRawTx(raw)
    }
    if (!thin.findTxid(txid)?.tx) return atomic
    const body = thin.toBinaryAtomic(txid)
    return body.length > 0 && body.length < atomic.length ? body : atomic
  } catch {
    return atomic
  }
}

export type ItemMigrateUnit<T> =
  /** One transaction carrying several tips. */
  | { kind: 'bundle'; items: T[] }
  /** One transaction carrying one tip — also where a split bundle ends. */
  | { kind: 'single'; item: T }
  | { kind: 'refuse'; reason: 'empty' }

/**
 * Plan the next transaction from the eligible tips, in page order so the
 * resumable cursor still advances over a prefix of the indexer page.
 */
export function chooseItemMigrateUnit<T>(
  items: readonly T[],
  itemsPerTx = MAX_ITEMS_PER_MIGRATE_TX,
): ItemMigrateUnit<T> {
  if (items.length === 0) return { kind: 'refuse', reason: 'empty' }
  const perTx = Math.max(1, Math.min(Math.floor(itemsPerTx), MAX_ITEMS_PER_MIGRATE_TX))
  if (items.length === 1 || perTx === 1) return { kind: 'single', item: items[0]! }
  return { kind: 'bundle', items: items.slice(0, perTx) }
}

/**
 * Split a rejected bundle in half. The failure belongs to one tip we cannot
 * identify from a broadcast rejection, so halving isolates it in log2 attempts
 * while every remaining tip still travels the same migrate path.
 */
export function splitItemMigrateBundle<T>(items: readonly T[]): [T[], T[]] {
  if (items.length <= 1) return [items.slice(0), []]
  const mid = Math.ceil(items.length / 2)
  return [items.slice(0, mid), items.slice(mid)]
}

export function describeItemMigrateUnit<T>(unit: ItemMigrateUnit<T>): string {
  switch (unit.kind) {
    case 'bundle':
      return `${unit.items.length} tips in one transaction`
    case 'single':
      return '1 tip in one transaction'
    case 'refuse':
      return 'nothing eligible'
  }
}
