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
}): OwnershipFate {
  if (args.inLiveSet) return 'keepLive'
  if (args.unjudged) return 'graceHold'

  if (args.tipKind.kind === 'covenantLocked') return 'keepCovenant'
  // Legacy brc156-proven tips may still be stuck covenant inventory.
  if (args.provenTier === 'brc156') return 'keepCovenant'

  // softP2pkh / unknown past grace and missing from the address set → drop.
  return 'ghostDrop'
}
