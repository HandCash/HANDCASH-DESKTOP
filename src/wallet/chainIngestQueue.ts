import { createSerialQueue } from './serialQueue'

/**
 * Shared queue for chain ingest (Dashboard sync + market migrate refresh).
 * Kept in its own module so syncFunds ↔ migration cannot form a cycle.
 */
const runExclusive = createSerialQueue()

export function runOnChainIngestQueue<T>(fn: () => Promise<T>): Promise<T> {
  return runExclusive(fn)
}
