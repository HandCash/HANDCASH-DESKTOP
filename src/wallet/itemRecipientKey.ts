import { PrivateKey } from '@bsv/sdk'
import type { ActiveWallet } from './session'
import { paymentTargetIsSelf, validateIdentityKey, type PaymentTarget } from './friends'
import {
  brc29PublicKey,
  freshRemittanceString,
  remittanceTag,
  selfBrc29Output,
  withRemittance,
  type DeliveryRemittance,
  type Remittance,
} from './brc29Keys'
import { rememberTipKey } from './tipKeys'

/**
 * Where one item output is locked. This wallet and an identity key get a
 * fresh BRC-29 child, which any BRC-100 wallet can sign for; the peer learns
 * its child from the remittance on the item envelope. A bare address is paid
 * as given.
 */
export type ItemRecipientKey =
  | { kind: 'self'; address: string; remittance: Remittance }
  | { kind: 'peer'; address: string; remittance: Remittance; identityKey: string }
  | { kind: 'address'; address: string }

export function planItemRecipientKey(
  wallet: Pick<ActiveWallet, 'rootKeyHex' | 'identityKey' | 'address'>,
  resolved: PaymentTarget,
  opts: { recipientIdentityKey?: string | null; derivationPrefix?: string } = {},
): ItemRecipientKey {
  const derivationPrefix = opts.derivationPrefix ?? freshRemittanceString()
  // An identity the caller already knows outranks the address it resolved to.
  const known = opts.recipientIdentityKey?.trim().toLowerCase() ?? ''
  const target: PaymentTarget =
    resolved.kind === 'address' && known && validateIdentityKey(known) === null
      ? { kind: 'identity', identityKey: known }
      : resolved
  if (paymentTargetIsSelf(target, wallet)) {
    const self = selfBrc29Output(wallet, derivationPrefix)
    rememberTipKey(wallet, self.key)
    return { kind: 'self', address: self.address, remittance: self.remittance }
  }
  if (target.kind === 'address') return { kind: 'address', address: target.address }
  const remittance: Remittance = {
    derivationPrefix,
    derivationSuffix: freshRemittanceString(),
    senderIdentityKey: wallet.identityKey.toLowerCase(),
  }
  const address = brc29PublicKey(
    PrivateKey.fromHex(wallet.rootKeyHex),
    remittance.derivationPrefix,
    remittance.derivationSuffix,
    target.identityKey,
  ).toAddress()
  return { kind: 'peer', address, remittance, identityKey: target.identityKey }
}

/** `customInstructions` and tags of an item row this wallet holds under `remittance`. */
export function heldItemRow(
  row: { customInstructions: string; tags: string[] },
  remittance: Remittance | null | undefined,
): { customInstructions: string; tags: string[] } {
  if (!remittance) return row
  const tag = remittanceTag(remittance)
  return {
    customInstructions: withRemittance(row.customInstructions, remittance),
    tags: tag ? [...row.tags.filter((t) => !t.startsWith('brc29:')), tag] : row.tags,
  }
}

/** The remittance of a self-held recipient key, or null for one paying someone else. */
export function heldRemittance(key: ItemRecipientKey): Remittance | null {
  return key.kind === 'self' ? key.remittance : null
}

/** The envelope remittance for the peer outputs of one item transfer, or undefined when none pays a peer. */
export function itemDeliveryRemittance(
  senderIdentityKey: string,
  outputs: { vout: number; key: ItemRecipientKey }[],
): DeliveryRemittance | undefined {
  const rows = outputs.flatMap(({ vout, key }) =>
    key.kind === 'peer'
      ? [{ vout, derivationPrefix: key.remittance.derivationPrefix, derivationSuffix: key.remittance.derivationSuffix }]
      : [],
  )
  return rows.length > 0 ? { senderIdentityKey: senderIdentityKey.toLowerCase(), outputs: rows } : undefined
}
