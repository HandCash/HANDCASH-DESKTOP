/**
 * Collectables on screen must be tips this address still holds as UTXOs.
 *
 * Basket `1sat` rows outlive a spend — `listOutputs` keeps returning them until
 * something writes `spendable: false`. The address UTXO set cannot lie that way:
 * a spent tip is gone, and a tip we never held is not there. The inventory list
 * is therefore the intersection of basket tips and live 1-sat outpoints.
 */

/**
 * How long a tip missing from the address scan stays unjudged.
 *
 * A scan that lands *after* the tip was first seen can still omit it while the
 * indexer catches up (self-send is the usual case). The old rule only spared tips
 * newer than the scan, so a fresh tip followed by a lagging scan was relinquished
 * as a ghost and vanished from inventory.
 */
export const OWNERSHIP_SETTLE_GRACE_MS = 10 * 60 * 1000

export function outpointKey(outpoint: string): string {
  return outpoint.trim().toLowerCase().replace(/_(\d+)$/, '.$1')
}

/** Live 1-sat tips on the receive address — latch dust and funding stay out. */
export function liveOneSatKeys(
  utxos: Array<{ outpoint: string; satoshis: number }>,
): Set<string> {
  const keys = new Set<string>()
  for (const u of utxos) {
    if (u.satoshis === 1) keys.add(outpointKey(u.outpoint))
  }
  return keys
}

/**
 * Split basket rows into tips the address still holds and everything else.
 * Call only with a successful address scan — silence must not empty the list.
 */
export function partitionByLiveUtxos<T extends { outpoint: string }>(
  outputs: T[],
  live: Set<string>,
): { owned: T[]; spentOrMissing: T[] } {
  const owned: T[] = []
  const spentOrMissing: T[] = []
  for (const o of outputs) {
    if (live.has(outpointKey(o.outpoint))) owned.push(o)
    else spentOrMissing.push(o)
  }
  return { owned, spentOrMissing }
}

/**
 * True when a missing tip must not yet be treated as spent.
 *
 * - Tip arrived after the scan ran → the scan cannot speak to it.
 * - Tip is still inside the settle grace → a newer scan may omit it while the
 *   address indexer lags behind a broadcast we already put in the basket.
 */
export function isOwnershipUnjudged(args: {
  firstSeenAt: number
  liveAt: number
  now?: number
  graceMs?: number
}): boolean {
  const now = args.now ?? Date.now()
  const grace = args.graceMs ?? OWNERSHIP_SETTLE_GRACE_MS
  if (args.firstSeenAt > args.liveAt) return true
  if (now - args.firstSeenAt < grace) return true
  return false
}
