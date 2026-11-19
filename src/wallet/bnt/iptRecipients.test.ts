import { PrivateKey, ProtoWallet, Utils } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { bntHolderPublicKey } from './keys'
import { iptRequestId, type IptProposal } from './iptProposal'
import { verifyIptRecipients, type IptRecipient } from './iptRecipients'

async function fixture() {
  const sender = PrivateKey.fromRandom()
  const recipient = PrivateKey.fromRandom().toPublicKey().toString()
  const acceptor = PrivateKey.fromRandom()
  const prover = new ProtoWallet(sender)
  const verifier = new ProtoWallet(acceptor)
  const revealed = await prover.revealSpecificKeyLinkage({
    counterparty: recipient, verifier: acceptor.toPublicKey().toString(),
    protocolID: [2, 'ipt holder'], keyID: 'prefix suffix',
  })
  const entry: IptRecipient = {
    vout: 0, identityKey: recipient, derivationPrefix: 'prefix', derivationSuffix: 'suffix',
    encryptedLinkage: Utils.toBase64(revealed.encryptedLinkage),
    encryptedLinkageProof: Utils.toBase64(revealed.encryptedLinkageProof),
  }
  const proposal: IptProposal = {
    requestId: iptRequestId([1]), ef: [1], assetId: 'ab'.repeat(20), inputs: [], amount: 1n,
    holders: [bntHolderPublicKey(sender, recipient, 'prefix', 'suffix', 'countersign')],
  }
  return { sender: sender.toPublicKey().toString(), verifier, entry, proposal }
}
describe('IPT encrypted recipient linkage', () => {
  it('opens actual SDK linkage and proves the output identity', async () => {
    const f = await fixture()
    await expect(verifyIptRecipients(f.verifier, f.sender, f.proposal, [f.entry])).resolves.toEqual([f.entry.identityKey])
  })
  it('rejects a substituted identity or holder', async () => {
    const f = await fixture()
    await expect(verifyIptRecipients(f.verifier, f.sender, f.proposal, [{ ...f.entry, identityKey: PrivateKey.fromRandom().toPublicKey().toString() }])).rejects.toThrow('holder')
    await expect(verifyIptRecipients(f.verifier, f.sender, { ...f.proposal, holders: [f.sender] }, [f.entry])).rejects.toThrow('holder')
  })
  it('requires every output exactly once and bounded canonical ciphertext', async () => {
    const f = await fixture()
    await expect(verifyIptRecipients(f.verifier, f.sender, f.proposal, [])).rejects.toThrow('every output')
    await expect(verifyIptRecipients(f.verifier, f.sender, f.proposal, [{ ...f.entry, vout: 1 }])).rejects.toThrow('recipient')
    await expect(verifyIptRecipients(f.verifier, f.sender, f.proposal, [{ ...f.entry, encryptedLinkage: '!' }])).rejects.toThrow('encoding')
  })
  it('rejects ciphertext sent to a different verifier or authenticated sender', async () => {
    const f = await fixture()
    await expect(verifyIptRecipients(new ProtoWallet(PrivateKey.fromRandom()), f.sender, f.proposal, [f.entry])).rejects.toThrow()
    await expect(verifyIptRecipients(f.verifier, PrivateKey.fromRandom().toPublicKey().toString(), f.proposal, [f.entry])).rejects.toThrow()
  })
})
