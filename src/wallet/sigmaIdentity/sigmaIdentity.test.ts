import { PrivateKey, Script, Transaction } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { classifyOwnedCash } from '../balanceView'
import {
  buildIdentityDocument,
  buildIdentityInscriptionScript,
  deriveSigmaIdentityPrivateKey,
  encodeIdentityDocument,
  identityAttestationMeta,
  identityDocumentFromLockingScript,
  linkSigmaIssuer,
  parseSigmaTail,
  personaIdFromName,
  reconstructSigmaIdentityPublicKey,
  sigmaIdentityBasket,
  sigmaSigningAddress,
  signSigmaIdentityChallenge,
  verifySigmaIdentityChallenge,
  verifySigmaVinBinding,
} from './index'
import { SIGMA_IDENTITY_MIME } from './constants'

describe('sigma identity', () => {
  const root = PrivateKey.fromRandom()
  const identityKey = root.toPublicKey().toString()

  it('keeps the persona path distinct from the root and a reserved basket', () => {
    expect(personaIdFromName('Studio North')).toBe('studio-north')
    expect(sigmaIdentityBasket('studio-north')).toBe('sigma-studio-north')
    expect(sigmaIdentityBasket('studio-north')).not.toBe('1sat')
    expect(sigmaIdentityBasket('studio-north')).not.toBe('bsv21')
    const child = deriveSigmaIdentityPrivateKey({
      rootKeyHex: root.toHex(),
      personaId: 'studio-north',
    })
    expect(child.toPublicKey().toString()).not.toBe(identityKey)
    expect(
      reconstructSigmaIdentityPublicKey({
        identityKey,
        personaId: 'studio-north',
      }).toString(),
    ).toBe(child.toPublicKey().toString())
  })

  it('inscribes a lean persona and binds Sigma to VIN 0', () => {
    const signer = deriveSigmaIdentityPrivateKey({
      rootKeyHex: root.toHex(),
      personaId: 'studio',
    })
    const doc = buildIdentityDocument({ id: 'studio', name: 'Studio', about: 'Paints' })
    const fundTxid = 'ab'.repeat(32)
    const script = buildIdentityInscriptionScript({
      address: sigmaSigningAddress(signer),
      body: encodeIdentityDocument(doc),
      metadataJson: identityAttestationMeta({ op: 'publish', id: 'studio' }),
      fundTxid,
      fundVout: 0,
      signer,
      vin: 0,
    })
    expect(script).toContain('7c')
    expect(script).toContain('5349474d41')
    expect(identityDocumentFromLockingScript(script)).toMatchObject({
      id: 'studio',
      name: 'Studio',
    })
    expect(identityDocumentFromLockingScript(script)?.about).toBe('Paints')
    const tail = parseSigmaTail(script)
    expect(tail).toMatchObject({
      algorithm: 'BSM',
      vin: 0,
      vinBound: true,
      address: sigmaSigningAddress(signer),
    })

    const tx = new Transaction()
    tx.addInput({ sourceTXID: fundTxid, sourceOutputIndex: 0 })
    tx.addOutput({ satoshis: 1, lockingScript: Script.fromHex(script) })
    expect(verifySigmaVinBinding(tx, 0, 0)).toBe(true)

    const replay = new Transaction()
    replay.addInput({ sourceTXID: 'cd'.repeat(32), sourceOutputIndex: 2 })
    replay.addOutput({ satoshis: 1, lockingScript: Script.fromHex(script) })
    expect(verifySigmaVinBinding(replay, 0, 0)).toBe(false)
  })

  it('refuses an unbound VIN', () => {
    const signer = deriveSigmaIdentityPrivateKey({
      rootKeyHex: root.toHex(),
      personaId: 'studio',
    })
    expect(() =>
      buildIdentityInscriptionScript({
        address: sigmaSigningAddress(signer),
        body: encodeIdentityDocument(buildIdentityDocument({ id: 'studio', name: 'Studio' })),
        metadataJson: identityAttestationMeta({ op: 'publish', id: 'studio' }),
        fundTxid: 'ab'.repeat(32),
        fundVout: 0,
        signer,
        vin: -1,
      }),
    ).toThrow(/VIN/)
  })

  it('links an NFT Sigma tail to the persona, not the root', () => {
    const signer = deriveSigmaIdentityPrivateKey({
      rootKeyHex: root.toHex(),
      personaId: 'studio',
    })
    const script = buildIdentityInscriptionScript({
      address: sigmaSigningAddress(signer),
      body: encodeIdentityDocument(buildIdentityDocument({ id: 'studio', name: 'Studio' })),
      metadataJson: identityAttestationMeta({ op: 'publish', id: 'studio' }),
      fundTxid: '11'.repeat(32),
      fundVout: 0,
      signer,
    })
    const linked = linkSigmaIssuer({
      lockingScript: script,
      customInstructions: JSON.stringify({
        issuerPersona: 'studio',
        issuerIdentity: identityKey,
        issuerName: 'Studio',
      }),
    })
    expect(linked?.linked).toBe(true)
    expect(linked?.context?.publicKey).toBe(signer.toPublicKey().toString().toLowerCase())
    expect(linked?.context?.publicKey).not.toBe(identityKey.toLowerCase())
    expect(linked?.context?.name).toBe('Studio')
    expect(linked?.context?.identityKey).not.toBe(linked?.context?.publicKey)
  })

  it('signs a challenge with the persona key and rejects a revoked control output', () => {
    const now = 1_700_000_000_000
    const signed = signSigmaIdentityChallenge({
      rootKeyHex: root.toHex(),
      personaId: 'studio',
      expiresAt: now + 60_000,
      nonce: 'nonce-value-123456',
    })
    expect(signed.publicKey).not.toBe(identityKey.toLowerCase())
    expect(
      verifySigmaIdentityChallenge({
        identityKey,
        personaId: 'studio',
        expiresAt: now + 60_000,
        nonce: 'nonce-value-123456',
        signature: signed.signature,
        now,
        control: { status: 'active', generation: 0 },
      }).ok,
    ).toBe(true)
    expect(
      verifySigmaIdentityChallenge({
        identityKey,
        personaId: 'studio',
        expiresAt: now + 60_000,
        nonce: 'nonce-value-123456',
        signature: signed.signature,
        now,
        control: { status: 'revoked', generation: 0 },
      }),
    ).toMatchObject({ ok: false })
  })

  it('does not count a persona basket as spendable cash', () => {
    expect(
      classifyOwnedCash(
        { satoshis: 1, spendable: true, basket: 'sigma-studio' },
        'none',
        'none',
      ),
    ).toEqual({ kind: 'exclude', reason: 'sigma' })
  })

  it('uses the identity mime, not a token payload, for the persona document', () => {
    expect(SIGMA_IDENTITY_MIME).toBe('application/sigma-identity+json')
  })
})
