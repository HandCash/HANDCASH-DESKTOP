/**
 * Collectables on screen must be tips this address still holds as UTXOs.
 *
 * Basket `1sat` rows outlive a spend — `listOutputs` keeps returning them until
 * something writes `spendable: false`. The address UTXO set cannot lie that way:
 * a spent tip is gone, and a tip we never held is not there. The inventory list
 * is therefore the intersection of basket tips and live 1-sat outpoints.
 */

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
