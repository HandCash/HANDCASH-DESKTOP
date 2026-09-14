import { describe, expect, it } from 'vitest'
import {
  BRC138_AUTH_PROOF_PROTOCOL,
  encodeBrc138Proof,
  validateWalletIdentityProofRequest,
  type Brc138ProofData,
} from './walletIdentityProof'

const IDENTITY = `02${'ab'.repeat(32)}`
const VERIFIER = `03${'cd'.repeat(32)}`
const NOW = 1_780_000_000_000
const NONCE = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)))

function proof(patch: Partial<Brc138ProofData> = {}, requestPatch: Record<string, unknown> = {}) {
  const data: Brc138ProofData = {
    action: 'login',
    identityKey: IDENTITY,
    expiresAt: NOW + 60_000,
    nonce: NONCE,
    ...patch,
  }
  return {
    data: Array.from(new TextEncoder().encode(encodeBrc138Proof(data))),
    protocolID: [...BRC138_AUTH_PROOF_PROTOCOL],
    keyID: data.nonce,
    counterparty: VERIFIER,
    ...requestPatch,
  }
}

describe('BRC-138 identity proof validation', () => {
  it('accepts a canonical proof addressed to a verifier', () => {
    expect(validateWalletIdentityProofRequest(proof(), IDENTITY, NOW)).toEqual({
      kind: 'valid',
      proof: {
        action: 'login',
        identityKey: IDENTITY,
        expiresAt: NOW + 60_000,
        nonce: NONCE,
      },
    })
  })

  it('rejects expired, over-long, and non-canonical statements', () => {
    expect(
      validateWalletIdentityProofRequest(proof({ expiresAt: NOW - 1 }), IDENTITY, NOW),
    ).toMatchObject({ kind: 'invalid', reason: expect.stringMatching(/expired/i) })
    expect(
      validateWalletIdentityProofRequest(
        proof({ expiresAt: NOW + 200_000 }),
        IDENTITY,
        NOW,
      ),
    ).toMatchObject({ kind: 'invalid', reason: expect.stringMatching(/window/i) })
    const canonical = encodeBrc138Proof({
      action: 'login',
      identityKey: IDENTITY,
      expiresAt: NOW + 60_000,
      nonce: NONCE,
    })
    expect(
      validateWalletIdentityProofRequest(
        proof({}, { data: Array.from(new TextEncoder().encode(`${canonical}\n`)) }),
        IDENTITY,
        NOW,
      ),
    ).toMatchObject({ kind: 'invalid', reason: expect.stringMatching(/canonical/i) })
  })

  it('rejects anyone-counterparty, wrong subject, and nonce/keyID mismatch', () => {
    expect(
      validateWalletIdentityProofRequest(proof({}, { counterparty: 'anyone' }), IDENTITY, NOW),
    ).toMatchObject({ kind: 'invalid', reason: expect.stringMatching(/verifier/i) })
    expect(
      validateWalletIdentityProofRequest(
        proof({ identityKey: VERIFIER }, { keyID: NONCE }),
        IDENTITY,
        NOW,
      ),
    ).toMatchObject({ kind: 'invalid', reason: expect.stringMatching(/identityKey/i) })
    expect(
      validateWalletIdentityProofRequest(proof({}, { keyID: 'other-nonce' }), IDENTITY, NOW),
    ).toMatchObject({ kind: 'invalid', reason: expect.stringMatching(/keyID/i) })
  })

  it('refuses the withdrawn HandCash challenge recipe', () => {
    expect(
      validateWalletIdentityProofRequest(
        {
          protocolID: [2, 'wallet identity proof'],
          keyID: 'identity-proof:app.example.com',
          counterparty: 'anyone',
          data: [1, 2, 3],
        },
        IDENTITY,
        NOW,
      ),
    ).toMatchObject({ kind: 'invalid', reason: expect.stringMatching(/withdrawn/i) })
  })

  it('leaves unrelated BRC-100 signatures untouched', () => {
    expect(
      validateWalletIdentityProofRequest(
        { protocolID: [2, 'document signing'] },
        IDENTITY,
        NOW,
      ),
    ).toEqual({ kind: 'not-identity-proof' })
  })
})
