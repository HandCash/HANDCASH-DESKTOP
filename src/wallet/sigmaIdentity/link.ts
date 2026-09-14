/**
 * Resolve a Sigma tail on an NFT or token to an issuer persona.
 *
 * Linked means: the signing address equals the BKDS child of a wallet identity
 * key at this persona path, and the signature names a concrete VIN. Name and
 * origin are context. They are not a second proof.
 */

import { PublicKey } from '@bsv/sdk'
import {
  reconstructSigmaIdentityPublicKey,
  sigmaSigningAddress,
} from './paths'
import { parseSigmaTail } from './script'

export type SigmaIssuerContext = {
  personaId: string
  generation: number
  name?: string
  origin?: string
  /** Wallet identity key the path was checked against. Not the persona key. */
  identityKey: string
  publicKey: string
  address: string
  vinBound: boolean
}

export type SigmaPersonaHint = {
  id: string
  generation: number
  identityKey: string
  name?: string
  origin?: string
  publicKey?: string
}

export type SigmaIssuerLink = {
  address: string
  algorithm: 'BSM' | 'BRC77'
  vin: number
  vinBound: boolean
  linked: boolean
  context: SigmaIssuerContext | null
}

function ciString(ci: Record<string, unknown> | null, key: string): string | null {
  const v = ci?.[key]
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function parseCi(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function addressOf(identityKey: string, personaId: string, generation: number): string | null {
  try {
    const pub = reconstructSigmaIdentityPublicKey({ identityKey, personaId, generation })
    return sigmaSigningAddress(pub)
  } catch {
    return null
  }
}

export function linkSigmaIssuer(args: {
  lockingScript: string
  customInstructions?: string | null
  selfIdentityKey?: string | null
  personas?: SigmaPersonaHint[]
}): SigmaIssuerLink | null {
  const tail = parseSigmaTail(args.lockingScript)
  if (!tail) return null
  const ci = parseCi(args.customInstructions ?? undefined)
  const personaId =
    ciString(ci, 'issuerPersona') ??
    (typeof ci?.sigmaIdentity === 'string' ? ci.sigmaIdentity : null)
  const generationRaw = ci?.issuerGeneration ?? ci?.sigmaIdentityGeneration
  const generation =
    typeof generationRaw === 'number' && Number.isInteger(generationRaw) && generationRaw >= 0
      ? generationRaw
      : 0
  const claimedIdentity = ciString(ci, 'issuerIdentity')
  const claimedName = ciString(ci, 'issuerName')
  const claimedOrigin = ciString(ci, 'issuerOrigin')

  const candidates: SigmaPersonaHint[] = []
  if (personaId && claimedIdentity) {
    candidates.push({
      id: personaId,
      generation,
      identityKey: claimedIdentity,
      ...(claimedName ? { name: claimedName } : {}),
      ...(claimedOrigin ? { origin: claimedOrigin } : {}),
    })
  }
  if (personaId && args.selfIdentityKey) {
    candidates.push({
      id: personaId,
      generation,
      identityKey: args.selfIdentityKey,
      ...(claimedName ? { name: claimedName } : {}),
      ...(claimedOrigin ? { origin: claimedOrigin } : {}),
    })
  }
  for (const persona of args.personas ?? []) {
    candidates.push(persona)
  }

  let matched: SigmaIssuerContext | null = null
  for (const persona of candidates) {
    const derived = addressOf(persona.identityKey, persona.id, persona.generation)
    if (!derived || derived !== tail.address) continue
    let publicKey = persona.publicKey ?? ''
    try {
      publicKey =
        reconstructSigmaIdentityPublicKey({
          identityKey: persona.identityKey,
          personaId: persona.id,
          generation: persona.generation,
        })
          .toString()
          .toLowerCase()
    } catch {
      if (!publicKey) continue
    }
    if (!publicKey) {
      try {
        publicKey = PublicKey.fromString(persona.identityKey).toString().toLowerCase()
      } catch {
        continue
      }
    }
    matched = {
      personaId: persona.id,
      generation: persona.generation,
      ...(persona.name || claimedName ? { name: persona.name ?? claimedName ?? undefined } : {}),
      ...(persona.origin || claimedOrigin
        ? { origin: persona.origin ?? claimedOrigin ?? undefined }
        : {}),
      identityKey: persona.identityKey.toLowerCase(),
      publicKey,
      address: tail.address,
      vinBound: tail.vinBound,
    }
    break
  }

  return {
    address: tail.address,
    algorithm: tail.algorithm,
    vin: tail.vin,
    vinBound: tail.vinBound,
    linked: Boolean(matched && tail.vinBound),
    context: matched,
  }
}
