/**
 * Durable first-seen + last-fail clocks for inbound tip hints.
 *
 * Chat `createdAt` resets when the messagebox redelivers the same envelope,
 * which made the 2h unresolvable grace restart forever. First-seen only moves
 * backward. Last-fail drives the body-less ingest backoff.
 */
import { createDurableTtlTxidMap } from './durableTtlTxidMap'

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60_000

const firstSeen = createDurableTtlTxidMap({
  key: 'handcash.wallet.inboundHintFirstSeen.v1',
  max: 500,
  ttlMs: THIRTY_DAYS_MS,
})

const lastFail = createDurableTtlTxidMap({
  key: 'handcash.wallet.inboundHintLastFail.v1',
  max: 500,
  ttlMs: THIRTY_DAYS_MS,
})

export function stampInboundHintFirstSeen(
  txid: string,
  candidate?: number,
): number {
  const now = Date.now()
  const hinted =
    Number.isFinite(candidate) && (candidate as number) > 0
      ? (candidate as number)
      : now
  const held = firstSeen.rememberedAt(txid)
  const oldest = held != null ? Math.min(held, hinted) : hinted
  return firstSeen.rememberOldest(txid, oldest) ?? oldest
}

export function inboundHintLastFailAt(txid: string): number | null {
  return lastFail.rememberedAt(txid)
}

export function noteInboundHintIngestFail(txid: string): void {
  lastFail.remember(txid)
}

export function clearInboundHintIngestFail(txid: string): void {
  lastFail.forget(txid)
}

export function __resetInboundHintClockForTests(): void {
  firstSeen.reset()
  lastFail.reset()
}
