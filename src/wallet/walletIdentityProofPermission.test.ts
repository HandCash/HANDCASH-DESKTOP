import { describe, expect, it } from 'vitest'
import { extractSatsFromArgs } from './appActivity'
import { humanActionCopy } from './appIdentity'
import { isIdentityProofMethod, summarizeAction } from './permissions'
import { BRC138_AUTH_PROOF_PROTOCOL, encodeBrc138Proof } from './walletIdentityProof'

const IDENTITY = `02${'ab'.repeat(32)}`
const VERIFIER = `03${'cd'.repeat(32)}`
const NONCE = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)))

function proofArgs(action: string) {
  const data = encodeBrc138Proof({
    action,
    identityKey: IDENTITY,
    expiresAt: 1_780_000_060_000,
    nonce: NONCE,
  })
  return {
    data: Array.from(new TextEncoder().encode(data)),
    protocolID: [...BRC138_AUTH_PROOF_PROTOCOL],
    keyID: NONCE,
    counterparty: VERIFIER,
  }
}

describe('BRC-138 identity proof permission copy', () => {
  it('shows the proof action and that signing cannot spend', () => {
    const action = summarizeAction('createSignature', proofArgs('login'))
    expect(action).toEqual({
      title: 'Prove wallet identity',
      summary: 'login',
      details: [
        'Signs a BRC-138 proof for the app verifier',
        'Does not authorize a payment or reveal private keys',
      ],
    })
    expect(humanActionCopy('createSignature', action.title)).toEqual({
      eyebrow: 'Identity proof',
      verb: 'wants a BRC-138 proof that this wallet holds its identity key',
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

  it('does not display an action from a non-canonical statement', () => {
    const args = proofArgs('login')
    const action = summarizeAction('createSignature', {
      ...args,
      data: Array.from(new TextEncoder().encode('login extra')),
    })
    expect(action.title).toBe('Sign with wallet')
    expect(action.summary).not.toContain('login')
  })
})
