/**
 * Exhaustive settle path for a signed collectable transfer.
 *
 * Spend classification (`SendPath`) decides *whether* we can soft-latch.
 * This union decides *who broadcasts* after `createAction({ noSend: true })`.
 * Broadcast-before-P2P is not a variant — peerDeliver has no sender-broadcast
 * edge. After inbox delivery the sender silently `postBeef` (`confirmBroadcast`).
 */
import { validateIdentityKey } from './friends'

export type ItemSettlePath =
  | { settle: 'peerDeliver'; recipientIdentityKey: string }
  | { settle: 'selfReceive' }
  | { settle: 'externalBroadcast'; reason: 'no-peer-identity' }

export type ChooseItemSettlePathArgs = {
  /** True when the new tip locking script pays this wallet's address. */
  paysOurAddress: boolean
  recipientIdentityKey?: string | null
}

/**
 * Classify once. Self-pay broadcasts locally. HandCash peers get Atomic BEEF
 * first (they broadcast). Pasted/external addresses have no identity box —
 * sender broadcasts. Never returns a "broadcast then maybe notify" path.
 */
export function chooseItemSettlePath(
  args: ChooseItemSettlePathArgs,
): ItemSettlePath {
  if (args.paysOurAddress) return { settle: 'selfReceive' }
  const raw = args.recipientIdentityKey?.trim() ?? ''
  if (raw && validateIdentityKey(raw) === null) {
    return {
      settle: 'peerDeliver',
      recipientIdentityKey: raw.toLowerCase(),
    }
  }
  return { settle: 'externalBroadcast', reason: 'no-peer-identity' }
}

export function isPeerDeliverSettle(
  path: ItemSettlePath | null | undefined,
): path is Extract<ItemSettlePath, { settle: 'peerDeliver' }> {
  return path?.settle === 'peerDeliver'
}

export function isSenderBroadcastSettle(
  path: ItemSettlePath | null | undefined,
): boolean {
  return path?.settle === 'selfReceive' || path?.settle === 'externalBroadcast'
}
