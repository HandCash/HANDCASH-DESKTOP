/**
 * Outpoint string formatting helpers shared across the collectable stack.
 *
 * Two textual forms exist in the wild:
 *   - dotted   `<txid>.<vout>`  (SDK / listOutputs)
 *   - underscore `<txid>_<vout>` (1Sat origin refs, remittance)
 *
 * These are pure string utilities — no BRC-156 / latch semantics.
 */

/** Normalize any outpoint form to `<txid>_<vout>` (lowercase). */
export function toUnderscoreOutpoint(outpoint: string): string {
  const n = outpoint.trim()
  if (n.includes('_')) return n.toLowerCase()
  return n.replace(/\.(\d+)$/, '_$1').toLowerCase()
}

/** Normalize any outpoint form to `<txid>.<vout>` (lowercase). */
export function toDottedOutpoint(outpoint: string): string {
  return toUnderscoreOutpoint(outpoint).replace(/_(\d+)$/, '.$1')
}
