/**
 * Ownership fate for a basket tip vs the address UTXO scan.
 *
 * Soft-latch P2PKH tips must leave inventory when the address no longer holds
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
   * `false` means the tip is locked to someone else (typical soft-latch send) —
   * never grace-hold those, or the sender gets false "Item received" toasts.
   * `null` / omitted = unknown (keep grace for indexer lag on self-receives).
   */
  paysOurAddress?: boolean | null
}): OwnershipFate {
  if (args.inLiveSet) return 'keepLive'

  const covenantLike =
    args.tipKind.kind === 'covenantLocked' || args.provenTier === 'brc156'

  // Soft tip locked to another address is not ours — even during settle grace.
  // Soft-latch createAction files the recipient tip in the sender's `1sat`
  // basket; without this, graceHold paints it as a receive.
  if (args.paysOurAddress === false && !covenantLike) {
    return 'ghostDrop'
  }

  if (args.unjudged) return 'graceHold'

  if (covenantLike) return 'keepCovenant'

  // softP2pkh / unknown past grace and missing from the address set → drop.
  return 'ghostDrop'
}
