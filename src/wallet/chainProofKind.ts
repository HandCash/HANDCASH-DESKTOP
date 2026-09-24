/**
 * How a transaction is known on this device — header digest vs unconfirmed cheque.
 *
 * Minimum SPV store: the header chain, and the full body of every unconfirmed
 * transaction in this wallet's history. Headers are inclusion. The BEEF is
 * authority. Arcade `/txs`, Bitails `/spent`, and indexer `isUtxo` are rumours
 * — they may cash or recover a lost projection; they never reclassify a
 * signed cheque as absent.
 *
 * Ingest finds coins. Digest classifies them. Mixing the two is how P2P
 * chaining dies: an indexer that has not seen a just-signed child answers
 * "absent", and Refresh treats that as a cancel. Unconfirmed txs have no
 * merkle root yet. The only SPV for them is the signed body plus every
 * unconfirmed ancestor body.
 */

export type ChainProofKind =
  | {
      kind: 'headerProven'
      /** Height whose header merkle root covers this tx. */
      height: number
    }
  | {
      kind: 'unconfirmed'
      /**
       * `bodies-complete` — every unconfirmed ancestor body is in the BEEF;
       * this cheque can be chained and posted.
       * `bodies-missing` — a parent body is absent; do not spend onward.
       */
      ancestry: 'bodies-complete' | 'bodies-missing'
    }
  | { kind: 'unknown' }

/**
 * May this output fund a new signed tx?
 *
 * Header-proven coins are always selectable. Unconfirmed coins are selectable
 * only when their ancestor bodies ride with the spend. Unknown is refuse —
 * we cannot build SPV for the child.
 */
export function maySelectAsInput(proof: ChainProofKind): boolean {
  if (proof.kind === 'headerProven') return true
  if (proof.kind === 'unconfirmed') return proof.ancestry === 'bodies-complete'
  return false
}

/**
 * What a child spend must carry so the payee/miner can SPV-verify.
 *
 * Unconfirmed → parent *bodies* (merkle proofs of those parents do not exist).
 * Header-proven → merkle path against the local header store.
 */
export type AncestryRide =
  | { ride: 'merkle-to-header'; height: number }
  | { ride: 'unconfirmed-bodies' }
  | { ride: 'refuse'; reason: 'unknown-proof' | 'missing-bodies' }

export function ancestryRideForSpend(proof: ChainProofKind): AncestryRide {
  if (proof.kind === 'headerProven') {
    return { ride: 'merkle-to-header', height: proof.height }
  }
  if (proof.kind === 'unconfirmed') {
    return proof.ancestry === 'bodies-complete'
      ? { ride: 'unconfirmed-bodies' }
      : { ride: 'refuse', reason: 'missing-bodies' }
  }
  return { ride: 'refuse', reason: 'unknown-proof' }
}

/** Hard finality — inclusion under a header we store. Arcade/indexer is not this. */
export function isHeaderFinal(proof: ChainProofKind): boolean {
  return proof.kind === 'headerProven'
}

/**
 * Map a BEEF ancestry gap (subject + parents in one package) onto proof kind.
 *
 * `none` means every parent has a merkle proof — the *subject* may still be
 * unconfirmed (a child of mined coins). That is still a chainable cheque.
 * Header finality for the subject itself is {@link verifyBumpFinality}, not this.
 */
export function proofKindFromBeefGap(
  gap: 'none' | 'unconfirmed-parents' | 'missing-bodies',
): ChainProofKind {
  if (gap === 'missing-bodies') {
    return { kind: 'unconfirmed', ancestry: 'bodies-missing' }
  }
  return { kind: 'unconfirmed', ancestry: 'bodies-complete' }
}
