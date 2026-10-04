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

/**
 * How a selection becomes one send transaction — never a silent fallthrough.
 *
 * There is no item ceiling: any selection is one atomic transaction, send or
 * burn. The old five-tip cap measured `Transaction.sign()` copying the whole
 * graph once per input; tips are signed one template at a time
 * (`signTipInputs`), and every per-tip loop yields to the UI.
 */
export type CollectableSendBatch =
  /** One tip, one `sendCollectable`. */
  | { kind: 'single'; outpoint: string }
  /** Several tips paired input-to-output in one atomic transaction. */
  | { kind: 'atomic'; outpoints: string[] }
  | { kind: 'refuse'; reason: 'empty' }

/** Decide the send shape for a raw user selection. */
export function chooseCollectableSendBatch(
  outpoints: string[],
): CollectableSendBatch {
  const normalized = normalizeCollectableBatchOutpoints(outpoints)
  if (normalized.length === 0) return { kind: 'refuse', reason: 'empty' }
  if (normalized.length === 1) {
    return { kind: 'single', outpoint: normalized[0]! }
  }
  return { kind: 'atomic', outpoints: normalized }
}

export function collectableSendBatchRefusal(
  batch: Extract<CollectableSendBatch, { kind: 'refuse' }>,
): string {
  switch (batch.reason) {
    case 'empty':
      return 'Select at least one collectable'
  }
}

/** Outputs are deliberately not randomized, so each input's remittance keeps its index. */
export function collectableBatchOutputOutpoint(txid: string, index: number): string {
  return `${txid.trim().toLowerCase()}.${index}`
}
