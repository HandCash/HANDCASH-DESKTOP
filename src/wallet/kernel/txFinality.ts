/**
 * Is an unmined transaction a payment yet? (BRC-67 step 4, BRC-9)
 *
 * SPV proves scripts, amounts and ancestry. It does not prove the sender is
 * done: a transaction with an input sequence below `0xFFFFFFFF` and a lock time
 * the chain has not reached is non-final, and its sender may still replace it.
 * Crediting one credits a promise. `@bsv/sdk` `Transaction.verify` and the
 * toolbox's `internalizeAction` check neither, so the wallet does.
 *
 * A mined transaction is final by definition; only the unproven ones in a
 * package are judged.
 */
export const SEQUENCE_FINAL = 0xffffffff
/** Below this a lock time is a block height, at or above it a unix time. */
export const LOCKTIME_THRESHOLD = 500_000_000
/** A block's median time past trails wall-clock time by about an hour. */
export const MEDIAN_TIME_LAG_S = 3_600

export type FinalityTx = { txid: string; lockTime: number; sequences: number[] }

export type ChainTip = { height: number; nowSec: number }

export type Finality =
  | { kind: 'final' }
  | { kind: 'nonFinal'; txid: string; lockTime: number; by: 'height' | 'time' }

/** Final whatever the tip: no lock time, or every input opted out of it. */
export function finalAtAnyTip(tx: FinalityTx): boolean {
  return tx.lockTime === 0 || tx.sequences.every((s) => s === SEQUENCE_FINAL)
}

export function lockTimeReached(lockTime: number, tip: ChainTip): boolean {
  return lockTime < LOCKTIME_THRESHOLD
    ? lockTime < tip.height + 1
    : lockTime < tip.nowSec - MEDIAN_TIME_LAG_S
}

export function judgeFinality(txs: FinalityTx[], tip: ChainTip | null): Finality | null {
  for (const tx of txs) {
    if (finalAtAnyTip(tx)) continue
    if (!tip) return null
    if (lockTimeReached(tx.lockTime, tip)) continue
    return {
      kind: 'nonFinal',
      txid: tx.txid,
      lockTime: tx.lockTime,
      by: tx.lockTime < LOCKTIME_THRESHOLD ? 'height' : 'time',
    }
  }
  return { kind: 'final' }
}
