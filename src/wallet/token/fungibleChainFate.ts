/**
 * What to do with a cached BSV-21 card the live basket read did not return.
 *
 * A mint that never reached the chain used to survive here forever: the durable
 * row kept painting, the encoding proof read its local script, and the card
 * offered Burn on a transaction no miner ever accepted. Absence from the basket
 * is not proof of anything on its own — toolbox projection lags a fresh mint,
 * and a deferred read returns nothing at all — so the decision needs a name.
 *
 * Same shape as the item paths: a tagged union, one pure decision, and a
 * reason that gets logged.
 */

export type FungibleChainFate =
  /** The live basket returned this outpoint — spendable per its own encoding. */
  | { kind: 'held' }
  /** Keep painting: the row may still be real. */
  | { kind: 'awaitingBasket'; reason: AwaitingReason }
  /** Old enough, never seen on chain, not in the basket — stop painting it. */
  | { kind: 'unconfirmed'; reason: 'never-seen-on-chain' }

export type AwaitingReason =
  /** listOutputs was deferred or failed — absence carries no information. */
  | 'live-read-unavailable'
  /** On chain, but the basket has not projected the row yet. */
  | 'basket-projection-lag'
  /** No provider can classify the tx — absence is not cancellation. */
  | 'chain-unknown'
  /** Freshly painted; broadcast and projection are still plausible. */
  | 'settling'

/** How long a mint may stay unproven before its card stops being painted. */
export const FUNGIBLE_SETTLE_GRACE_MS = 10 * 60_000

export function chooseFungibleChainFate(args: {
  inLiveBasket: boolean
  /** False when the read was deferred, threw, or the wallet was locked. */
  liveReadUsable: boolean
  /** `true` only on a positive lookup; `null` means unknown (404 included). */
  onChain: boolean | null
  /** Age of the cached row. Rows written before this field existed are old. */
  ageMs: number
  graceMs?: number
}): FungibleChainFate {
  if (args.inLiveBasket) return { kind: 'held' }
  if (!args.liveReadUsable) {
    return { kind: 'awaitingBasket', reason: 'live-read-unavailable' }
  }
  if (args.onChain === true) {
    return { kind: 'awaitingBasket', reason: 'basket-projection-lag' }
  }
  if (args.ageMs < (args.graceMs ?? FUNGIBLE_SETTLE_GRACE_MS)) {
    return { kind: 'awaitingBasket', reason: 'settling' }
  }
  if (args.onChain == null) {
    return { kind: 'awaitingBasket', reason: 'chain-unknown' }
  }
  return { kind: 'unconfirmed', reason: 'never-seen-on-chain' }
}
