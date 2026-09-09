import { toDottedOutpoint } from './outpointFormat'

/** Normalize and de-duplicate a user-selected batch without reordering it. */
export function normalizeCollectableBatchOutpoints(outpoints: string[]): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const raw of outpoints) {
    const outpoint = toDottedOutpoint(raw.trim()).toLowerCase()
    if (!outpoint || seen.has(outpoint)) continue
    seen.add(outpoint)
    normalized.push(outpoint)
  }
  return normalized
}

/** Outputs are deliberately not randomized, so each input's remittance keeps its index. */
export function collectableBatchOutputOutpoint(txid: string, index: number): string {
  return `${txid.trim().toLowerCase()}.${index}`
}
