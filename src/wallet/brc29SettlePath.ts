/**
 * Exhaustive settle path for a signed BRC-29 payment.
 *
 * Broadcast-before-inbox is not a variant. `peerDeliver` has no sender-broadcast
 * edge until remittance is in the box. Unreachable box → abort noSend and
 * identity-address P2PKH (`identityFallback`), not a scan receipt.
 */
import { validateIdentityKey } from './friends'

export type Brc29SettlePath =
  | { settle: 'peerDeliver'; recipientIdentityKey: string }
  | { settle: 'selfReceive' }

export type ChooseBrc29SettlePathArgs = {
  payeeIdentityKey: string
  ourIdentityKey?: string | null
}

/**
 * Classify once. Same identity → this device internalizes and still posts the
 * envelope to our inbox so other devices can ingest. HandCash peers get the
 * remittance (± Atomic BEEF) in their box; they broadcast when BEEF is inline.
 */
export function chooseBrc29SettlePath(
  args: ChooseBrc29SettlePathArgs,
): Brc29SettlePath {
  const payee = args.payeeIdentityKey.trim().toLowerCase()
  const us = args.ourIdentityKey?.trim().toLowerCase() ?? ''
  if (us && payee === us) return { settle: 'selfReceive' }
  if (payee && validateIdentityKey(payee) === null) {
    return { settle: 'peerDeliver', recipientIdentityKey: payee }
  }
  throw new Error('Invalid payee identity key')
}

export function isBrc29PeerDeliver(
  path: Brc29SettlePath | null | undefined,
): path is Extract<Brc29SettlePath, { settle: 'peerDeliver' }> {
  return path?.settle === 'peerDeliver'
}
