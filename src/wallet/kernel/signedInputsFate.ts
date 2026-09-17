/**
 * Spend status of every input on a locally signed transaction.
 *
 * `unsigned` — no transaction was built. `spent` — the coins moved on chain.
 * `unspent` — the coins are still live. `unknown` — nothing could answer, which
 * every caller must treat as a refusal, not as `unspent`.
 *
 * Pure type: shared by the attempt classifier and the reclaim path so the two
 * cannot drift apart or depend on each other.
 */
export type SignedInputsFate = 'unsigned' | 'spent' | 'unspent' | 'unknown'
