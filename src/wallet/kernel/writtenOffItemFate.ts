/**
 * Fate of a basket `1sat` row storage holds as `spendable: false` while the
 * address scan lists its outpoint unspent at this wallet's address.
 *
 * An item leaves the basket three honest ways: a send spends it (storage sets
 * `spentBy`, the sent guard remembers it), the holder relinquishes it, or the
 * chain names a spender. A row hidden any other way — a failed import leg, a
 * fail closure that took every leg funded by its change, a bulk write-off — is
 * a held item the grid cannot list and Refresh never brings back. The coins sit
 * at the address; on 0.1.682 the scan listed 2,820 tips and Collect held 1,013.
 *
 * The address scan is the chain's answer: an outpoint it lists unspent at our
 * address is on chain or in the mempool, so its creator was broadcast whatever
 * the local row says. Only the creator's local status decides how to restore.
 */

import { APP_HELD_TX_STATUSES, isLiveLocalTxStatus } from './txLiveness'

export type WrittenOffItemFacts = {
  /** Storage `spentBy` is set — a local send owns this tip. */
  spentLocally: boolean
  /** The sent guard holds it, or the holder relinquished it. */
  leftOnPurpose: boolean
  /** The app's lock overlay holds the tip: sealed, reserved or quarantined. */
  overlayHeld: boolean
  /** Local status of the transaction that created the row; empty when missing. */
  creatorStatus: string
}

export type WrittenOffItemFate =
  /** Creator is live locally: flip the row back to spendable. */
  | { kind: 'restore' }
  /** Creator was failed locally yet the chain holds its output: revive it first. */
  | { kind: 'reviveCreator' }
  /** Creator is still broadcast-held locally yet the chain holds its output: pin it first. */
  | { kind: 'pinCreator' }
  | {
      kind: 'keep'
      reason: 'spentLocally' | 'leftOnPurpose' | 'overlayHeld' | 'creatorUnsigned' | 'creatorMissing'
    }

const appHeld: ReadonlySet<string> = new Set(APP_HELD_TX_STATUSES)

export function decideWrittenOffItemFate(facts: WrittenOffItemFacts): WrittenOffItemFate {
  if (facts.spentLocally) return { kind: 'keep', reason: 'spentLocally' }
  if (facts.leftOnPurpose) return { kind: 'keep', reason: 'leftOnPurpose' }
  if (facts.overlayHeld) return { kind: 'keep', reason: 'overlayHeld' }
  const status = facts.creatorStatus.trim().toLowerCase()
  if (!status) return { kind: 'keep', reason: 'creatorMissing' }
  if (status === 'failed') return { kind: 'reviveCreator' }
  if (appHeld.has(status)) return { kind: 'pinCreator' }
  if (status === 'completed' || isLiveLocalTxStatus(status)) return { kind: 'restore' }
  // `unsigned` / `unprocessed`: nothing this wallet signed can be on chain.
  return { kind: 'keep', reason: 'creatorUnsigned' }
}
