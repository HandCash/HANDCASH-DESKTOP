/**
 * Whether a held collectable may be sent from this device right now.
 *
 * **Verified** (BRC-150 verdict) is enough to enable Send. The display badge
 * does not require the ~400k remittance blob to still be in localStorage —
 * that proof is omitted when over budget, and must not gray every verified
 * Pixel Fox. Send attaches stored remittance when present and does not
 * re-walk hops.
 *
 * Authenticity is an advisory badge, not a custody gate. Indexers and BRC-150
 * verification continue asynchronously; a held tip remains sendable while that
 * work is pending or when cryptographic lineage is unavailable.
 */
import { Beef, Utils } from '@bsv/sdk'
import { getRememberedProvenanceRemittance } from './oneSatProvenance'

export type CollectableSendReadyReason =
  | 'verifying'
  | 'unproven'

export type CollectableSendReady =
  | { ready: true }
  | { ready: false; reason: CollectableSendReadyReason }

function remittanceBeef(outpoint: string): Beef | null {
  const rem = getRememberedProvenanceRemittance(outpoint)
  if (!rem?.beefB64) return null
  try {
    return Beef.fromBinary(Utils.toArray(rem.beefB64, 'base64'))
  } catch {
    return null
  }
}

/** Stored remittance BEEF for this tip — no network. */
export function storedCollectableInputBeef(outpoint: string): number[] | null {
  const beef = remittanceBeef(outpoint)
  if (!beef) return null
  try {
    return beef.toBinary()
  } catch {
    return null
  }
}

export function collectableSendReadyMessage(
  reason: CollectableSendReadyReason,
): string {
  if (reason === 'verifying') {
    return 'This collectable is still verifying authenticity.'
  }
  if (reason === 'unproven') {
    return 'Send is available after authenticity is verified.'
  }
  return 'This collectable is not ready to send.'
}

export function inspectCollectableSendReady(args: {
  outpoint: string
  proven: boolean
  verifying: boolean
}): CollectableSendReady {
  void args
  // Wallet custody and a spendable locking script authorize sending. Identity
  // verification never blocks ownership actions; Arcade receives the chain
  // through the wallet's BEEF package.
  return { ready: true }
}

/** Test helper. */
export function resetCollectableSendReadyForTests(): void {
  // No mutable readiness state.
}
