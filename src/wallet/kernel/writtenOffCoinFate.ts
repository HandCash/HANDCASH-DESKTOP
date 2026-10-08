/**
 * Fate of a default-basket coin storage holds as `spendable: false` with no
 * local spender.
 *
 * Two kinds of row look alike there. A coin a bulk release wrote off while it
 * was still unspent: the hero balance never counts it and no send can select
 * it. And change the chain shows spent by a transaction this wallet never
 * stored: the balance keeps crediting it as "confirming" when its creator is
 * still local `unproven`. The change-restore window only ever reaches the
 * first page of unspendable rows, so on a wallet with years of history neither
 * kind is ever looked at (hc-ad7afb, 2026-10-08: 180 unspent coins worth
 * 1,149,812 sats hidden; 45 change coins worth 133,712 sats credited after the
 * consolidation d65f31d0 spent them).
 *
 * Restoring needs an affirmative unspent answer and a creator that is settled
 * locally, so a coin a live send still owns is never handed back. Hiding needs
 * the chain to name a spender this wallet does not hold.
 */

import type { TxLiveness } from './txLiveness'

export type WrittenOffCoinFacts = {
  satoshis: number
  /** Liveness of the transaction that created the coin. */
  creator: TxLiveness
  /** Storage `spentBy` is set — a signed-cheque claim the reclaim path owns. */
  spentLocally: boolean
  /** The app's lock overlay holds the coin: sealed, reserved or quarantined. */
  overlayHeld: boolean
  hasScript: boolean
}

/** A row worth asking the chain about. */
export function isWrittenOffCandidate(facts: WrittenOffCoinFacts): boolean {
  if (facts.satoshis <= 0) return false
  if (facts.spentLocally || facts.overlayHeld) return false
  return facts.creator === 'settled' || facts.creator === 'pending'
}

export type ChainSpendAnswer =
  | { kind: 'unspent' }
  | { kind: 'spent'; spender: string; spenderIsLocal: boolean }
  | { kind: 'unknown' }

export type WrittenOffCoinFate =
  /** Settled creator, chain says unspent. Still proven per coin before writing. */
  | { kind: 'restore' }
  /** The chain names a spender this wallet never stored. */
  | { kind: 'hide'; spender: string }
  | {
      kind: 'keep'
      reason:
        | 'notCandidate'
        | 'chainSilent'
        | 'spenderLocal'
        /** Change of a live local send: the spend-path promote owns it. */
        | 'liveChange'
        /** `allocateChangeInput` crashes on a script-less row. */
        | 'noScript'
    }

export function decideWrittenOffCoinFate(
  facts: WrittenOffCoinFacts,
  chain: ChainSpendAnswer,
): WrittenOffCoinFate {
  if (!isWrittenOffCandidate(facts)) return { kind: 'keep', reason: 'notCandidate' }
  if (chain.kind === 'unknown') return { kind: 'keep', reason: 'chainSilent' }
  if (chain.kind === 'spent') {
    return chain.spenderIsLocal
      ? { kind: 'keep', reason: 'spenderLocal' }
      : { kind: 'hide', spender: chain.spender }
  }
  if (facts.creator !== 'settled') return { kind: 'keep', reason: 'liveChange' }
  if (!facts.hasScript) return { kind: 'keep', reason: 'noScript' }
  return { kind: 'restore' }
}
