import { KeyDeriver, PrivateKey } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import {
  BNT_ISSUER_SIGNER,
  IPT_HOLDER_PROTOCOL,
  IPT_ISSUER_PROTOCOL,
  bntHolderKeyFor,
  bntHolderPrivateKey,
  bntHolderPublicKey,
  bntHolderSigner,
  bntIssuerKeyOf,
  bntIssuerPrivateKey,
  bntIssuerSigner,
} from './keys'

// BRC-253 §2: countersigned (IPT) issuer and holder keys never share the BNT namespace.
describe('IPT key namespaces', () => {
  const issuer = PrivateKey.fromRandom()
  const holder = PrivateKey.fromRandom()
  const remittance = { derivationPrefix: 'p', derivationSuffix: 's', senderIdentityKey: issuer.toPublicKey().toString() }

  it('issuer signer follows the mode and matches the derivable issuer key', () => {
    expect(bntIssuerSigner()).toEqual(BNT_ISSUER_SIGNER)
    const ipt = bntIssuerSigner('countersign')
    expect(ipt.protocolID).toEqual(IPT_ISSUER_PROTOCOL)
    const signed = new KeyDeriver(issuer).derivePrivateKey(ipt.protocolID, ipt.keyID, ipt.counterparty).toPublicKey().toString()
    expect(signed).toBe(bntIssuerKeyOf(issuer.toPublicKey().toString(), 'countersign'))
    expect(signed).toBe(bntIssuerPrivateKey(issuer, 'countersign').toPublicKey().toString())
    expect(signed).not.toBe(bntIssuerKeyOf(issuer.toPublicKey().toString(), 'open'))
  })

  it('holder keys differ by mode and the holder can sign the key the sender wrote', () => {
    const recipient = holder.toPublicKey().toString()
    const open = bntHolderPublicKey(issuer, recipient, 'p', 's')
    const ipt = bntHolderPublicKey(issuer, recipient, 'p', 's', 'countersign')
    expect(ipt).not.toBe(open)
    expect(bntHolderPrivateKey(holder, remittance, 'countersign').toPublicKey().toString()).toBe(ipt)
    expect(bntHolderSigner(recipient, remittance, 'countersign').protocolID).toEqual(IPT_HOLDER_PROTOCOL)
    expect(bntHolderKeyFor(recipient, recipient, 'p', 's', 'countersign').counterparty).toBe('self')
  })
})
