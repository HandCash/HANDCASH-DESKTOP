/**
 * BRC-100 createAction pieces for a Sigma identity.
 * The fund output is spent as VIN 0 of the publish / rotate / revoke transaction
 * so the Sigma tail binds a known outpoint. It lives in the persona basket,
 * never in `default`, so coin selection cannot spend it as cash.
 */

import { p2pkhScriptHex } from '../ordinalOwnership'
import { SIGMA_IDENTITY_COUNTERPARTY, SIGMA_IDENTITY_PROTOCOL_ID } from './constants'
import {
  assetIssuerMeta,
  buildIdentityDocument,
  encodeIdentityDocument,
  identityAttestationMeta,
} from './payload'
import { personaKeyId, sigmaIdentityBasket } from './paths'
import { buildIdentityInscriptionScript } from './script'
import type { PrivateKey } from '@bsv/sdk'

export type SigmaActionOutput = {
  satoshis: number
  lockingScript: string
  outputDescription: string
  basket: string
  tags: string[]
  customInstructions: string
}

function spendCi(args: {
  role: 'control' | 'fund'
  id: string
  generation: number
  origin?: string
}): string {
  return JSON.stringify({
    v: 1,
    role: args.role,
    id: args.id,
    generation: args.generation,
    protocolID: [...SIGMA_IDENTITY_PROTOCOL_ID],
    keyID: personaKeyId(args.id, args.generation),
    counterparty: SIGMA_IDENTITY_COUNTERPARTY,
    ...(args.origin ? { origin: args.origin } : {}),
  })
}

export function personaLockingScript(address: string): string {
  return p2pkhScriptHex(address)
}

export function buildSigmaFundOutput(args: {
  personaId: string
  generation: number
  address: string
}): SigmaActionOutput {
  const basket = sigmaIdentityBasket(args.personaId)
  return {
    satoshis: 1,
    lockingScript: personaLockingScript(args.address),
    outputDescription: 'Sigma identity fund',
    basket,
    tags: ['sigma-identity', 'role:fund', `id:${args.personaId}`],
    customInstructions: spendCi({
      role: 'fund',
      id: args.personaId,
      generation: args.generation,
    }),
  }
}

export function buildSigmaControlOutput(args: {
  personaId: string
  generation: number
  address: string
  origin?: string
}): SigmaActionOutput {
  const basket = sigmaIdentityBasket(args.personaId)
  return {
    satoshis: 1,
    lockingScript: personaLockingScript(args.address),
    outputDescription: 'Sigma identity control',
    basket,
    tags: ['sigma-identity', 'role:control', `id:${args.personaId}`],
    customInstructions: spendCi({
      role: 'control',
      id: args.personaId,
      generation: args.generation,
      origin: args.origin,
    }),
  }
}

export function buildSigmaDocumentOutput(args: {
  personaId: string
  name: string
  about?: string
  generation: number
  address: string
  signer: PrivateKey
  fundTxid: string
  fundVout: number
  op: 'publish' | 'rotate' | 'revoke'
  origin?: string
}): SigmaActionOutput {
  const doc = buildIdentityDocument({
    id: args.personaId,
    name: args.name,
    about: args.about,
  })
  const lockingScript = buildIdentityInscriptionScript({
    address: args.address,
    body: encodeIdentityDocument(doc),
    metadataJson: identityAttestationMeta({
      op: args.op,
      id: args.personaId,
      generation: args.generation,
      origin: args.origin,
    }),
    fundTxid: args.fundTxid,
    fundVout: args.fundVout,
    signer: args.signer,
    vin: 0,
  })
  return {
    satoshis: 1,
    lockingScript,
    outputDescription:
      args.op === 'revoke' ? 'Sigma identity revocation' : 'Sigma identity',
    basket: sigmaIdentityBasket(args.personaId),
    tags: [
      'sigma-identity',
      `role:${args.op === 'publish' ? 'document' : args.op}`,
      `id:${args.personaId}`,
    ],
    customInstructions: JSON.stringify({
      v: 1,
      role: args.op === 'publish' ? 'document' : args.op,
      ...doc,
      ...(args.origin ? { origin: args.origin } : {}),
    }),
  }
}

export function issuerStamp(args: {
  personaId: string
  publicKey: string
  identityKey: string
  generation: number
  name?: string
  origin?: string
  app: '1sat_nft' | 'bsv21'
}): { metadataJson: string; customInstructions: string; tags: string[] } {
  return {
    metadataJson: assetIssuerMeta({
      app: args.app,
      personaId: args.personaId,
      publicKey: args.publicKey,
      origin: args.origin,
    }),
    customInstructions: JSON.stringify({
      issuer: args.publicKey,
      issuerIdentity: args.identityKey,
      issuerPersona: args.personaId,
      issuerGeneration: args.generation,
      ...(args.name ? { issuerName: args.name } : {}),
      ...(args.origin ? { issuerOrigin: args.origin } : {}),
    }),
    tags: [`issuer:${args.publicKey}`, `sigma-identity:${args.personaId}`],
  }
}
