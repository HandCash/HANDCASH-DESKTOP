/**
 * SPV of a signed package before it is posted.
 *
 * - `verified`: every unmined tx in the package has every source output, every
 *   unlocking script evaluates, no tx spends more than it has, and every merkle
 *   proof names a root a header source confirms at that height.
 * - `invalid`: an unmined tx in the package can never be valid — a script or
 *   amount fails, or the tx is malformed. No miner will take it, ever.
 * - `incomplete`: not judged yet — a source body is missing, a header is not
 *   known, or a proof this wallet assembled disagrees with the chain. The tx
 *   may be fine; the package is not provably so. It is not posted until it is.
 */
export type SpvVerdict =
  | { kind: 'verified' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'incomplete'; reason: string }

const INVALID_RE =
  /has no inputs|has no outputs|coinbase input|more than once|source output that does not exist|Script evaluation error|Script verification failed|does not reference its supplied source|insufficient fee/i

/** `Transaction.verify` returned false: a script or the amounts failed. */
export const SPV_SCRIPT_FAILED: SpvVerdict = {
  kind: 'invalid',
  reason: 'a signature, script or amount does not verify',
}

/** `Transaction.verify` threw. Only a named defect of the tx itself is invalid. */
export function classifySpvThrow(err: unknown): SpvVerdict {
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 240)
  return INVALID_RE.test(message)
    ? { kind: 'invalid', reason: message }
    : { kind: 'incomplete', reason: message }
}
