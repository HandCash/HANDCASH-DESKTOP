/**
 * The Litecoin block every install's header chain starts from. It sits below
 * the first backed deposit, so every deposit a reader checks is after it and
 * covered by the forward sync; moving it up would leave older deposits
 * reachable only by linking down by hash, which `headers.ts` caps. Write a new
 * one only with `npm run ltc:checkpoint -- --height <below every deposit>`.
 */
export type LtcCheckpoint = {
  height: number
  hash: string
  bits: number
  time: number
  /** Times of the last blocks of the retarget windows at or before `height`, which the next retarget reads. */
  windowEnds: Record<number, number>
}

export const LTC_CHECKPOINT: LtcCheckpoint = {
  height: 3196900,
  hash: 'a787508568de2a41691a8982acc2942772675c46b1525720cdb5e52f9a2eda4e',
  bits: 422800385,
  time: 1792284459,
  windowEnds: { 3193343: 1791740629, 3195359: 1792058721 },
}
