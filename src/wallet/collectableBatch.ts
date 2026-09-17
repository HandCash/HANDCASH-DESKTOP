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
 * Tips one atomic 1-sat transaction may carry — send or burn.
 *
 * Five is the measured UI-safe ceiling for provenance-heavy tips.
 *
 * Twenty-five was inherited from phrase migration, whose inputs are simpler.
 * A real collectable send at ten tips repeatedly blocked the renderer for
 * 1.5–3.4 seconds and failed before being split; five signed successfully.
 * Keep migration's independent ceiling there — these are different workloads.
 */
export const MAX_ITEMS_PER_ONE_SAT_TX = 5

/**
 * How a selection becomes one send transaction — never a silent fallthrough.
 *
 * This is the *atomic* decision. A selection above the ceiling refuses here;
 * `planCollectableSendRun` is what turns it into a sequence of legs.
 */
export type CollectableSendBatch =
  /** One tip, one `sendCollectable`. */
  | { kind: 'single'; outpoint: string }
  /** Several tips paired input-to-output in one atomic transaction. */
  | { kind: 'atomic'; outpoints: string[] }
  | { kind: 'refuse'; reason: 'empty' }
  | { kind: 'refuse'; reason: 'tooMany'; count: number; max: number }

/** Decide the send shape for a raw user selection. */
export function chooseCollectableSendBatch(
  outpoints: string[],
): CollectableSendBatch {
  const normalized = normalizeCollectableBatchOutpoints(outpoints)
  if (normalized.length === 0) return { kind: 'refuse', reason: 'empty' }
  if (normalized.length === 1) {
    return { kind: 'single', outpoint: normalized[0]! }
  }
  if (normalized.length > MAX_ITEMS_PER_ONE_SAT_TX) {
    return {
      kind: 'refuse',
      reason: 'tooMany',
      count: normalized.length,
      max: MAX_ITEMS_PER_ONE_SAT_TX,
    }
  }
  return { kind: 'atomic', outpoints: normalized }
}

export function collectableSendBatchRefusal(
  batch: Extract<CollectableSendBatch, { kind: 'refuse' }>,
): string {
  switch (batch.reason) {
    case 'empty':
      return 'Select at least one collectable'
    case 'tooMany':
      return `One transaction carries up to ${batch.max} collectables, not ${batch.count}. Send a larger selection as a run of legs (sendCollectablesRun).`
  }
}

/** Burn is the same atomic ceiling: n tips in, one recovery output. */
export function collectableBurnBatchRefusal(count: number): string | null {
  if (count <= MAX_ITEMS_PER_ONE_SAT_TX) return null
  return `One burn carries up to ${MAX_ITEMS_PER_ONE_SAT_TX} collectables. Select ${MAX_ITEMS_PER_ONE_SAT_TX} or fewer of the ${count}.`
}

/** Outputs are deliberately not randomized, so each input's remittance keeps its index. */
export function collectableBatchOutputOutpoint(txid: string, index: number): string {
  return `${txid.trim().toLowerCase()}.${index}`
}
