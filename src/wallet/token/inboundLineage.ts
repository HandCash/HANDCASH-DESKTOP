import { base64ToBytes } from '../base64Binary'

/** Largest BSV-21 lineage that rides an envelope; a longer one is omitted, never truncated. */
export const TOKEN_LINEAGE_MAX_BYTES = 96 * 1024

const MAX_INBOUND = 32
const inbound = new Map<string, number[]>()

/**
 * Lineage an inbox envelope carried for `txid`. The card stays un-ACK'd until
 * its settle succeeds, so every retry redelivers it; memory is enough.
 */
export function noteInboundTokenLineage(txid: string, b64: string | undefined): void {
  const key = txid.trim().toLowerCase()
  if (!b64 || !/^[0-9a-f]{64}$/.test(key)) return
  try {
    const bytes = Array.from(base64ToBytes(b64))
    if (bytes.length === 0 || bytes.length > TOKEN_LINEAGE_MAX_BYTES) return
    inbound.delete(key)
    inbound.set(key, bytes)
    if (inbound.size > MAX_INBOUND) inbound.delete(inbound.keys().next().value!)
  } catch {
    // A malformed lineage is no lineage: the payee walks parents instead.
  }
}

export function inboundTokenLineage(txid: string): number[] | null {
  return inbound.get(txid.trim().toLowerCase()) ?? null
}

export function resetInboundTokenLineageForTests(): void {
  inbound.clear()
}
