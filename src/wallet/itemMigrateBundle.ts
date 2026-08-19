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

/** Tips per transaction. Beyond this the sighash work per attempt dominates. */
export const MAX_ITEMS_PER_MIGRATE_TX = 25

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
