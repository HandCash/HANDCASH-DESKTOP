/**
 * Exhaustive settle path for a signed collectable transfer.
 *
 * Spend classification (`SendPath`) decides *whether* the tip can be spent.
 * This union decides where the asset metadata/remittance goes after signing.
 * It does not alter transaction propagation: every signed transfer uses the
 * same durable miner + SPV lifecycle as an ordinary BSV payment.
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
 * Classify once. Self-pay internalizes locally. HandCash peers get an Atomic
 * BEEF notification. Pasted/external addresses have no identity box.
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
