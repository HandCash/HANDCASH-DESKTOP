import { describe, expect, it } from 'vitest'
import { extractSatsFromArgs } from './appActivity'
import { humanActionCopy } from './appIdentity'
import { isIdentityProofMethod, summarizeAction } from './permissions'
import {
  serializeWalletIdentityChallenge,
  WALLET_IDENTITY_PROOF_DOMAIN,
  WALLET_IDENTITY_PROOF_PROTOCOL,
} from './walletIdentityProof'

function proofArgs(purpose: string) {
  const data = serializeWalletIdentityChallenge({
    domain: WALLET_IDENTITY_PROOF_DOMAIN,
    version: 1,
    origin: 'app.example.com',
    nonce: 'AQEBAQEBAQEBAQEBAQEBAQ',
    issuedAt: 1_780_000_000_000,
    expiresAt: 1_780_000_060_000,
    purpose,
  })
  return {
    data: Array.from(new TextEncoder().encode(data)),
    protocolID: [...WALLET_IDENTITY_PROOF_PROTOCOL],
    keyID: 'identity-proof:app.example.com',
    counterparty: 'anyone',
  }
}

describe('wallet identity proof permission copy', () => {
  it('shows the canonical challenge purpose and limits', () => {
    const action = summarizeAction(
      'createSignature',
      proofArgs('Sign in and restore my Example session'),
    )
    expect(action).toEqual({
      title: 'Prove wallet identity',
      summary: 'Sign in and restore my Example session',
      details: [
        'Signs a short-lived challenge bound to this app',
        'Does not authorize a payment or reveal private keys',
      ],
    })
    expect(humanActionCopy('createSignature', action.title)).toEqual({
      eyebrow: 'Identity proof',
      verb: 'wants proof that this wallet approved its challenge',
    })
  })

  it('treats deferred-sign payment finalization as a payment amount', () => {
    const args = {
      reference: 'abc123',
      spends: {},
      outputs: [
        { satoshis: 500, outputDescription: 'Coffee' },
        { satoshis: 250, outputDescription: 'Tip' },
      ],
    }

    expect(extractSatsFromArgs('signAction', args)).toBe(750)
    expect(summarizeAction('signAction', args)).toEqual({
      title: 'Confirm payment',
      summary: 'Finish signing a payment you already started',
      details: ['Coffee: 500 sats', 'Tip: 250 sats'],
      amountSats: 750,
      amountLabel: '750 sats',
    })
  })

  it('does not grant generic signatures identity-proof session permissions', () => {
    expect(isIdentityProofMethod('createSignature')).toBe(false)
    expect(isIdentityProofMethod('proveCertificate')).toBe(true)
  })

  it('does not display purpose from non-canonical bytes', () => {
    const args = proofArgs('Misleading purpose')
    const pretty = JSON.stringify(
      JSON.parse(new TextDecoder().decode(new Uint8Array(args.data))),
      null,
      2,
    )
    const action = summarizeAction('createSignature', {
      ...args,
      data: Array.from(new TextEncoder().encode(pretty)),
    })
    expect(action.title).toBe('Sign with wallet')
    expect(action.summary).not.toContain('Misleading purpose')
  })
})
