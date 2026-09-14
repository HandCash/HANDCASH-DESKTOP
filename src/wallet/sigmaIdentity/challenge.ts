/**
 * Off-chain API challenges. Signed by the persona key, never the root.
 * Revocation is not a signature — callers must pass live control-UTXO state.
 */

import { BSM, Signature, Utils } from '@bsv/sdk'
import {
  CHALLENGE_CLOCK_SKEW_MS,
  CHALLENGE_VALIDITY_MS,
} from './constants'
import {
  deriveSigmaIdentityPrivateKey,
  reconstructSigmaIdentityPublicKey,
  sigmaSigningAddress,
} from './paths'

export type SigmaControlView = {
  /** Unspent control output naming this generation. */
  status: 'active' | 'revoked' | 'missing'
  generation: number
}

export type SigmaIdentityChallenge = {
  personaId: string
  generation: number
  publicKey: string
  expiresAt: number
  nonce: string
}

const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/

export function sigmaIdentityChallengeStatement(proof: SigmaIdentityChallenge): string {
  return [
    'sigma-identity',
    proof.personaId,
    String(proof.generation),
    proof.publicKey,
    String(proof.expiresAt),
    proof.nonce,
  ].join('\n')
}

export function signSigmaIdentityChallenge(args: {
  rootKeyHex: string
  personaId: string
  generation?: number
  expiresAt: number
  nonce: string
}): { statement: string; signature: string; publicKey: string; address: string } {
  const generation = args.generation ?? 0
  if (!NONCE_RE.test(args.nonce)) {
    throw new Error('Challenge nonce must be 16–128 unreserved characters.')
  }
  const key = deriveSigmaIdentityPrivateKey({
    rootKeyHex: args.rootKeyHex,
    personaId: args.personaId,
    generation,
  })
  const publicKey = key.toPublicKey().toString().toLowerCase()
  const statement = sigmaIdentityChallengeStatement({
    personaId: args.personaId,
    generation,
    publicKey,
    expiresAt: args.expiresAt,
    nonce: args.nonce,
  })
  const signature = BSM.sign(Utils.toArray(statement, 'utf8'), key, 'base64')
  if (typeof signature !== 'string') throw new Error('Challenge sign failed.')
  return {
    statement,
    signature,
    publicKey,
    address: sigmaSigningAddress(key),
  }
}

export function verifySigmaIdentityChallenge(args: {
  identityKey: string
  personaId: string
  generation?: number
  expiresAt: number
  nonce: string
  signature: string
  now: number
  control: SigmaControlView
}): { ok: true; publicKey: string } | { ok: false; reason: string } {
  const generation = args.generation ?? 0
  if (!NONCE_RE.test(args.nonce)) return { ok: false, reason: 'Weak nonce.' }
  if (args.control.status !== 'active' || args.control.generation !== generation) {
    return { ok: false, reason: 'Sigma identity control output is not active.' }
  }
  if (args.expiresAt > args.now + CHALLENGE_VALIDITY_MS + CHALLENGE_CLOCK_SKEW_MS) {
    return { ok: false, reason: 'Challenge expiry is too far ahead.' }
  }
  if (args.expiresAt + CHALLENGE_CLOCK_SKEW_MS < args.now) {
    return { ok: false, reason: 'Challenge expired.' }
  }
  let publicKey: string
  try {
    publicKey = reconstructSigmaIdentityPublicKey({
      identityKey: args.identityKey,
      personaId: args.personaId,
      generation,
    })
      .toString()
      .toLowerCase()
  } catch {
    return { ok: false, reason: 'Could not reconstruct the Sigma identity key.' }
  }
  const statement = sigmaIdentityChallengeStatement({
    personaId: args.personaId,
    generation,
    publicKey,
    expiresAt: args.expiresAt,
    nonce: args.nonce,
  })
  try {
    const sig = Signature.fromCompact(args.signature, 'base64')
    const pub = reconstructSigmaIdentityPublicKey({
      identityKey: args.identityKey,
      personaId: args.personaId,
      generation,
    })
    const ok = BSM.verify(Utils.toArray(statement, 'utf8'), sig, pub)
    if (!ok) return { ok: false, reason: 'Challenge signature does not match the Sigma identity.' }
  } catch {
    return { ok: false, reason: 'Challenge signature is not valid.' }
  }
  return { ok: true, publicKey }
}
