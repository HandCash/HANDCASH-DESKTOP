import { Beef } from '@bsv/sdk'
import { judgeFinality, SEQUENCE_FINAL, type FinalityTx } from './kernel/txFinality'

export type IncomingFinalityReason = 'non-final' | 'finality-unknown'

export class IncomingNotFinalError extends Error {
  readonly reason: IncomingFinalityReason
  constructor(reason: IncomingFinalityReason, message: string) {
    super(message)
    this.name = 'IncomingNotFinalError'
    this.reason = reason
  }
}

/** Every transaction in the package that carries no merkle proof. */
export function unprovenTxsOf(atomic: number[]): FinalityTx[] {
  return Beef.fromBinary(atomic).txs.flatMap((b) =>
    b.tx && !b.hasProof
      ? [
          {
            txid: b.txid,
            lockTime: b.tx.lockTime,
            sequences: b.tx.inputs.map((input) => input.sequence ?? SEQUENCE_FINAL),
          },
        ]
      : [],
  )
}

/**
 * Refuse an incoming package whose unmined transactions are not final. The
 * tip is only fetched when a lock time is live; a tip nobody can supply then
 * refuses too, since the payment cannot be shown final.
 */
export async function assertIncomingFinal(
  atomic: number[],
  getHeight: () => Promise<number>,
): Promise<void> {
  let txs: FinalityTx[]
  try {
    txs = unprovenTxsOf(atomic)
  } catch {
    return
  }
  let verdict = judgeFinality(txs, null)
  if (!verdict) {
    const height = await getHeight().catch(() => 0)
    verdict =
      height > 0 ? judgeFinality(txs, { height, nowSec: Math.floor(Date.now() / 1_000) }) : null
  }
  if (verdict?.kind === 'final') return
  if (!verdict) {
    console.warn('[internalize] refused reason=finality-unknown — no chain height for a live lock time')
    throw new IncomingNotFinalError(
      'finality-unknown',
      'This payment carries a lock time the wallet could not check against the chain. Nothing was credited.',
    )
  }
  const until =
    verdict.by === 'height'
      ? `block ${verdict.lockTime}`
      : new Date(verdict.lockTime * 1_000).toISOString()
  console.warn(
    `[internalize] ${verdict.txid.slice(0, 12)} refused reason=non-final lockTime=${verdict.lockTime} by=${verdict.by}`,
  )
  throw new IncomingNotFinalError(
    'non-final',
    `This payment is not final until ${until} — its sender can still replace it. Nothing was credited.`,
  )
}
