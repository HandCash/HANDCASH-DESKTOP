import type { SettleWait } from './settle'
import { activeSwaps } from './settleStore'
import type { SettleRecord } from './settleStore'

/**
 * Waits after which a swap's next move is this wallet's own signature: its
 * lock, or the taker's claim. The maker's claim is covered by the claim tower,
 * and a refund can wait for any later unlock, so neither holds the wallet open.
 */
const NEEDS_THIS_WALLET: ReadonlySet<SettleWait> = new Set(['accept', 'presign', 'peer-funding', 'peer-burial', 'chain-time'])
/** A swap mid-step with no deadline on record is held this long, then looked at again. */
const STEP_HOLD_MS = 10 * 60_000

function holdOf(r: SettleRecord, now: number): number | null {
  if (r.phase === 'locking' || r.phase === 'claiming') return now + STEP_HOLD_MS
  if (!r.waiting || !NEEDS_THIS_WALLET.has(r.waiting.for)) return null
  const until = r.waiting.until ?? now + STEP_HOLD_MS
  return until > now ? until : null
}

/** Until when (unix ms) auto-lock waits because a swap needs this wallet to sign; null when none does. */
export function swapUnlockHold(records: readonly SettleRecord[] = activeSwaps(), now = Date.now()): number | null {
  let latest: number | null = null
  for (const r of records) {
    const until = holdOf(r, now)
    if (until !== null && (latest === null || until > latest)) latest = until
  }
  return latest
}
