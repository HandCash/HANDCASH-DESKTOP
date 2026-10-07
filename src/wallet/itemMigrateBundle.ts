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
import { Beef, type BEEF } from '@bsv/sdk'

/**
 * Tips per transaction: one import chunk. Each action already carries the
 * chunk's whole input BEEF, so a larger bundle costs no extra download — only
 * one fee, one signing pass and one broadcast where there used to be four.
 */
export const MAX_ITEMS_PER_MIGRATE_TX = 100

/**
 * Source bytes one migrate may carry. The signed package is the durable retry
 * body, and the archive holding it is a 1MB store shared by every unproven
 * cheque: a package over this left the migrate with no durable retry at all.
 * Items whose parents carry their art fill it in a few tips; plain transfers
 * still bundle a whole chunk.
 */
export const MAX_MIGRATE_SOURCE_BYTES = 256 * 1024

/** Bytes a tip adds to its package: the source transactions it needs, by txid. */
export type ItemSourceCost = ReadonlyArray<{ txid: string; bytes: number }>

/**
 * How many tips, in page order, fit one package. Shared sources count once.
 * Never fewer than one: a tip whose own sources exceed the budget still moves,
 * alone, rather than being stranded.
 */
export function itemsWithinSourceBudget<T>(
  items: readonly T[],
  itemsPerTx: number,
  costOf: (item: T) => ItemSourceCost,
  budget = MAX_MIGRATE_SOURCE_BYTES,
): number {
  const cap = Math.max(1, Math.min(Math.floor(itemsPerTx), MAX_ITEMS_PER_MIGRATE_TX, items.length))
  const counted = new Set<string>()
  let bytes = 0
  let fit = 0
  for (const item of items.slice(0, cap)) {
    let added = 0
    const fresh: string[] = []
    for (const { txid, bytes: size } of costOf(item)) {
      if (counted.has(txid) || fresh.includes(txid)) continue
      fresh.push(txid)
      added += size
    }
    // A tip whose sources are already counted adds nothing to the package.
    if (fit > 0 && added > 0 && bytes + added > budget) break
    for (const txid of fresh) counted.add(txid)
    bytes += added
    fit += 1
  }
  return Math.max(1, fit)
}

/** What each source transaction adds to a migrate package: its body and proof, or its parents'. */
export function migrateSourceCosts(inputBeef: BEEF): (txid: string) => ItemSourceCost {
  let beef: Beef | null = null
  try {
    beef = Beef.fromBinary(inputBeef)
  } catch {
    beef = null
  }
  const memo = new Map<string, ItemSourceCost>()
  const sizeOf = (txid: string): number => {
    const entry = beef?.findTxid(txid)
    if (!entry) return 0
    const proof = entry.bumpIndex != null ? beef!.bumps[entry.bumpIndex]?.toBinary().length ?? 0 : 0
    return (entry.rawTx?.length ?? 0) + proof
  }
  return (txid) => {
    const known = memo.get(txid)
    if (known) return known
    const entry = beef?.findTxid(txid)
    const cost: Array<{ txid: string; bytes: number }> = [{ txid, bytes: sizeOf(txid) }]
    if (entry?.tx && entry.bumpIndex == null) {
      for (const input of entry.tx.inputs) {
        const parent = String(input.sourceTXID ?? '').toLowerCase()
        if (parent) cost.push({ txid: parent, bytes: sizeOf(parent) })
      }
    }
    memo.set(txid, cost)
    return cost
  }
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
