/**
 * Ownership fate for a basket tip vs the address UTXO scan.
 *
 * Spendable P2PKH tips must leave inventory when the address no longer holds
 * them (past settle grace). Covenant-locked tips never appear on that scan —
 * they stay until the user explicitly abandons them.
 */
import type { TipKind, ProvenTier } from './collectableTipKind'

export type OwnershipFate =
  | 'keepLive'
  | 'graceHold'
  | 'keepCovenant'
  | 'ghostDrop'

export function ownershipFate(args: {
  tipKind: TipKind
  inLiveSet: boolean
  /** Tip is inside settle grace or newer than the scan. */
  unjudged: boolean
  provenTier?: ProvenTier | null
  /**
   * When known from the tip locking script: does it pay this wallet's address?
   * `false` means the tip is locked to someone else (typical outbound send) —
   * never grace-hold those, or the sender gets false "Item received" toasts.
   * `null` / omitted = unknown (keep grace for indexer lag on self-receives).
   */
  paysOurAddress?: boolean | null
}): OwnershipFate {
  if (args.inLiveSet) return 'keepLive'
  void args.provenTier

  const covenantLike = args.tipKind.kind === 'covenantLocked'

  // Tip locked to another address is not ours — even during settle grace.
  // createAction files the recipient tip in the sender's `1sat` basket;
  // without this, graceHold paints it as a receive.
  if (args.paysOurAddress === false && !covenantLike) {
    return 'ghostDrop'
  }

  if (args.unjudged) return 'graceHold'

  if (covenantLike) return 'keepCovenant'

  // Tip still locks to us — address scan may lag Bitails / WoC. Relinquishing
  // here orphaned inventory while Activity still showed the receive.
  if (args.paysOurAddress === true) return 'graceHold'

  // listOutputs often omits lockingScript. Unknown ≠ "not ours" — ghost-dropping
  // after a failed send burned live 1-sats off the basket.
  if (args.paysOurAddress !== false) return 'graceHold'

  return 'ghostDrop'
}
