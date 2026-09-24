import { describe, expect, it } from 'vitest'
import { normalizeAppHost } from './appIdentity'
import { normalizeOrigin } from './permissions'
import {
  serializeWalletIdentityChallenge,
  validateWalletIdentityProofRequest,
  WALLET_IDENTITY_PROOF_DOMAIN,
  WALLET_IDENTITY_PROOF_PROTOCOL,
  walletIdentityProofKeyID,
  type WalletIdentityChallenge,
} from './walletIdentityProof'

const ORIGIN = 'app.example.com'
const NOW = 1_780_000_000_000

function request(
  patch: Partial<WalletIdentityChallenge> = {},
  requestPatch: Record<string, unknown> = {},
) {
  const challenge: WalletIdentityChallenge = {
    domain: WALLET_IDENTITY_PROOF_DOMAIN,
    version: 1,
    origin: ORIGIN,
    nonce: 'AQEBAQEBAQEBAQEBAQEBAQ',
    issuedAt: NOW - 1_000,
    expiresAt: NOW + 60_000,
    purpose: 'Sign in to Example',
    ...patch,
  }
  return {
    data: Array.from(new TextEncoder().encode(serializeWalletIdentityChallenge(challenge))),
    protocolID: [...WALLET_IDENTITY_PROOF_PROTOCOL],
    keyID: walletIdentityProofKeyID(ORIGIN),
    counterparty: 'anyone',
    ...requestPatch,
  }
}

describe('wallet identity proof validation', () => {
  it('accepts the canonical origin-bound BRC-100 signing recipe', () => {
    expect(validateWalletIdentityProofRequest(request(), ORIGIN, NOW)).toEqual({
      kind: 'valid',
      challenge: expect.objectContaining({
        origin: ORIGIN,
        purpose: 'Sign in to Example',
      }),
    })
  })

  it('rejects cross-origin, expired, and non-canonical challenges', () => {
    expect(
      validateWalletIdentityProofRequest(request({ origin: 'evil.example' }), ORIGIN, NOW),
    ).toMatchObject({ kind: 'invalid', reason: expect.stringMatching(/origin/i) })
    expect(
      validateWalletIdentityProofRequest(
        request({ issuedAt: NOW - 100_000, expiresAt: NOW - 90_000 }),
        ORIGIN,
        NOW,
      ),
    ).toMatchObject({ kind: 'invalid', reason: expect.stringMatching(/expired/i) })

    const canonical = serializeWalletIdentityChallenge({
      domain: WALLET_IDENTITY_PROOF_DOMAIN,
      version: 1,
      origin: ORIGIN,
      nonce: 'AQEBAQEBAQEBAQEBAQEBAQ',
      issuedAt: NOW - 1_000,
      expiresAt: NOW + 60_000,
      purpose: 'Sign in to Example',
    })
    const pretty = JSON.stringify(JSON.parse(canonical), null, 2)
    expect(
      validateWalletIdentityProofRequest(
        request({}, { data: Array.from(new TextEncoder().encode(pretty)) }),
        ORIGIN,
        NOW,
      ),
    ).toMatchObject({ kind: 'invalid', reason: expect.stringMatching(/canonical/i) })
  })

  it('rejects weak nonces and recipe parameter substitution', () => {
    expect(
      validateWalletIdentityProofRequest(request({ nonce: 'short' }), ORIGIN, NOW),
    ).toMatchObject({ kind: 'invalid', reason: expect.stringMatching(/128 bits/i) })
    expect(
      validateWalletIdentityProofRequest(
        request({}, { keyID: 'identity-proof:other.example' }),
        ORIGIN,
        NOW,
      ),
    ).toMatchObject({ kind: 'invalid', reason: expect.stringMatching(/keyID/i) })
    expect(
      validateWalletIdentityProofRequest(request({}, { counterparty: 'self' }), ORIGIN, NOW),
    ).toMatchObject({ kind: 'invalid', reason: expect.stringMatching(/anyone/i) })
  })

  it('leaves unrelated BRC-100 signatures untouched', () => {
    expect(
      validateWalletIdentityProofRequest(
        { protocolID: [2, 'document signing'] },
        ORIGIN,
        NOW,
      ),
    ).toEqual({ kind: 'not-identity-proof' })
  })

  /**
   * `normalizeOrigin` collapses every HandCash catalog host onto `handcash.io`
   * so one view grant covers the market. Handing that alias to the proof
   * validator rejected honest proofs from those hosts
   * (`code=INVALID_IDENTITY_PROOF` from brc-cloud) and would have let a proof
   * minted for one catalog host verify as another. Identity proofs bind to the
   * requesting host — `normalizeAppHost`.
   */
  it('binds a catalog host to itself, never to the shared view-grant alias', () => {
    const CATALOG = 'brc-cloud.bcryderman.workers.dev'
    expect(normalizeAppHost(CATALOG)).toBe(CATALOG)
    expect(normalizeOrigin(CATALOG)).toBe('handcash.io')

    const proof = {
      data: Array.from(
        new TextEncoder().encode(
          serializeWalletIdentityChallenge({
            domain: WALLET_IDENTITY_PROOF_DOMAIN,
            version: 1,
            origin: CATALOG,
            nonce: 'AQEBAQEBAQEBAQEBAQEBAQ',
            issuedAt: NOW - 1_000,
            expiresAt: NOW + 60_000,
            purpose: 'Run the HandCash BRC-100 reference implementation',
          }),
        ),
      ),
      protocolID: [...WALLET_IDENTITY_PROOF_PROTOCOL],
      keyID: walletIdentityProofKeyID(CATALOG),
      counterparty: 'anyone',
    }

    expect(
      validateWalletIdentityProofRequest(proof, normalizeAppHost(CATALOG), NOW),
    ).toMatchObject({ kind: 'valid' })
    expect(
      validateWalletIdentityProofRequest(proof, normalizeOrigin(CATALOG), NOW),
    ).toMatchObject({ kind: 'invalid', reason: expect.stringMatching(/keyID/i) })
  })
})
