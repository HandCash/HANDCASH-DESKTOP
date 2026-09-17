/**
 * Ownership fate for a basket tip vs the address UTXO scan.
 *
 * Address scans find tips; absence is not spend proof. Outbound scripts can be
 * rejected immediately, while locally-addressed tips remain until a sent mark
 * or affirmative spent-outpoint evidence retires them.
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
   * `null` / omitted = unknown script (listOutputs sometimes omits it).
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

  // Missing from an address index is still only absence. Heal/sent-item state
  // owns removal once a spend is proven; do not cancel a P2P cheque here.
  return 'graceHold'
}
