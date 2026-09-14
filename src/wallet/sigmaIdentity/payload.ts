/**
 * Lean on-chain payloads. Challenges, nonces, and API tokens stay off chain.
 */

import { ABOUT_MAX, NAME_MAX, SIGMA_IDENTITY_VERSION } from './constants'
import { normalizePersonaId } from './paths'

export type SigmaIdentityDocument = {
  v: typeof SIGMA_IDENTITY_VERSION
  id: string
  name: string
  about?: string
}

export type SigmaIdentityOp = 'publish' | 'rotate' | 'revoke'

export type SigmaControlRecord = {
  v: typeof SIGMA_IDENTITY_VERSION
  role: 'control' | 'fund'
  id: string
  generation: number
  protocolID: [0, 'sigma identity']
  keyID: string
  counterparty: 'anyone'
  origin?: string
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function normalizePersonaName(raw: string): string | null {
  const name = raw.trim().replace(/\s+/g, ' ')
  if (!name || name.length > NAME_MAX) return null
  if (/[\u0000-\u001f]/.test(name)) return null
  return name
}

export function normalizeAbout(raw: string | undefined): string | undefined {
  if (raw == null) return undefined
  const about = raw.trim().replace(/\s+/g, ' ')
  if (!about) return undefined
  if (about.length > ABOUT_MAX) return undefined
  if (/[\u0000-\u001f]/.test(about)) return undefined
  return about
}

export function buildIdentityDocument(args: {
  id: string
  name: string
  about?: string
}): SigmaIdentityDocument {
  const id = normalizePersonaId(args.id)
  const name = normalizePersonaName(args.name)
  if (!id || !name) throw new Error('Sigma identity needs a name and a short id.')
  const about = normalizeAbout(args.about)
  if (args.about?.trim() && !about) {
    throw new Error(`Context must be ${ABOUT_MAX} characters or fewer, with no control characters.`)
  }
  return {
    v: SIGMA_IDENTITY_VERSION,
    id,
    name,
    ...(about ? { about } : {}),
  }
}

export function encodeIdentityDocument(doc: SigmaIdentityDocument): Uint8Array {
  return encoder.encode(JSON.stringify(doc))
}

export function parseIdentityDocument(body: Uint8Array): SigmaIdentityDocument | null {
  try {
    const parsed = JSON.parse(decoder.decode(body)) as {
      v?: unknown
      id?: unknown
      name?: unknown
      about?: unknown
    }
    if (parsed.v !== SIGMA_IDENTITY_VERSION) return null
    if (typeof parsed.id !== 'string' || typeof parsed.name !== 'string') return null
    const id = normalizePersonaId(parsed.id)
    const name = normalizePersonaName(parsed.name)
    if (!id || !name) return null
    const about =
      typeof parsed.about === 'string' ? normalizeAbout(parsed.about) : undefined
    return { v: SIGMA_IDENTITY_VERSION, id, name, ...(about ? { about } : {}) }
  } catch {
    return null
  }
}

/** Signed OP_RETURN context sitting in front of the Sigma tail. Not the persona document. */
export function identityAttestationMeta(args: {
  op: SigmaIdentityOp
  id: string
  generation?: number
  origin?: string
}): string {
  const id = normalizePersonaId(args.id)
  if (!id) throw new Error('Sigma identity id must be a short lowercase slug.')
  return JSON.stringify({
    p: 'sigma-identity',
    op: args.op,
    id,
    ...(args.generation != null && args.generation > 0
      ? { generation: args.generation }
      : {}),
    ...(args.origin ? { origin: args.origin } : {}),
  })
}

/** Issuer context signed onto an NFT or token output. Lean — name lives on the persona inscription. */
export function assetIssuerMeta(args: {
  app: '1sat_nft' | 'bsv21'
  personaId: string
  publicKey: string
  origin?: string
}): string {
  const id = normalizePersonaId(args.personaId)
  if (!id) throw new Error('Sigma identity id must be a short lowercase slug.')
  return JSON.stringify({
    app: args.app,
    issuerPersona: id,
    issuer: args.publicKey,
    ...(args.origin ? { issuerOrigin: args.origin } : {}),
  })
}
