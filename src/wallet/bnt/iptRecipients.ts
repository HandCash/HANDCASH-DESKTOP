import { PrivateKey, PublicKey, Utils, type WalletInterface } from '@bsv/sdk'
import type { IptProposal } from './iptProposal'

export type IptRecipient = {
  vout: number
  identityKey: string
  derivationPrefix: string
  derivationSuffix: string
  encryptedLinkage: string
  encryptedLinkageProof: string
}
const KEY = /^0[23][0-9a-f]{64}$/
function ciphertext(value: string): number[] {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Invalid IPT recipient linkage encoding')
  }
  const bytes = Utils.toArray(value, 'base64')
  if (Utils.toBase64(bytes) !== value) throw new Error('Invalid IPT recipient linkage encoding')
  return bytes
}

/** BRC-253 §5 / BRC-69 / BRC-72. The sender is authenticated by the enclosing
 * BRC-78 message. Each output, including change, must prove its named owner.
 * Uses wallet decryption, never exports the acceptor's private key.
 */
export async function verifyIptRecipients(
  wallet: Pick<WalletInterface, 'decrypt'>,
  sender: string,
  proposal: IptProposal,
  recipients: readonly IptRecipient[],
): Promise<string[]> {
  if (!KEY.test(sender) || !Array.isArray(recipients) || recipients.length !== proposal.holders.length) {
    throw new Error('IPT recipients must name every output')
  }
  const holders = [...proposal.holders]
  const entries = recipients.map((entry) => ({ ...entry }))
  const identities = new Array<string>(holders.length)
  // Bound and validate the complete list before doing wallet cryptography.
  const seen = new Set<number>()
  for (const entry of entries) {
    if (!entry || !Number.isInteger(entry.vout) || entry.vout < 0 || entry.vout >= identities.length ||
        seen.has(entry.vout) || !KEY.test(entry.identityKey) ||
        typeof entry.derivationPrefix !== 'string' || typeof entry.derivationSuffix !== 'string' ||
        !entry.derivationPrefix || !entry.derivationSuffix || entry.derivationPrefix.length > 64 ||
        entry.derivationSuffix.length > 64 || /\s/.test(entry.derivationPrefix + entry.derivationSuffix)) {
      throw new Error('Invalid IPT recipient')
    }
    ciphertext(entry.encryptedLinkage)
    ciphertext(entry.encryptedLinkageProof)
    seen.add(entry.vout)
  }
  for (const entry of entries) {
    const args = {
      protocolID: [2, 'specific linkage revelation 2 ipt holder'] as [2, string],
      keyID: `${entry.derivationPrefix} ${entry.derivationSuffix}`,
      counterparty: sender,
    }
    const { plaintext: linkage } = await wallet.decrypt({ ...args, ciphertext: ciphertext(entry.encryptedLinkage) })
    const { plaintext: proof } = await wallet.decrypt({ ...args, ciphertext: ciphertext(entry.encryptedLinkageProof) })
    // The installed BRC-69 specific-linkage implementation uses proof type 0.
    // The ownership equation itself binds the named identity to the holder.
    if (linkage.length !== 32 || proof.length !== 1 || proof[0] !== 0) throw new Error('Invalid IPT recipient linkage')
    const scalar = new PrivateKey(linkage)
    const point = PublicKey.fromString(entry.identityKey).add(scalar.toPublicKey())
    if (point.encode(true, 'hex') !== holders[entry.vout]) {
      throw new Error('IPT recipient linkage does not prove its holder')
    }
    identities[entry.vout] = entry.identityKey
  }
  return identities
}
