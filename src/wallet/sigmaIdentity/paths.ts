/**
 * Deterministic Sigma identity paths (BRC-100 BKDS / BRC-42).
 *
 * Invoice number is `0-sigma identity-<keyID>`. Generation 0 uses the persona
 * id as keyID so the common path stays short. Later generations append
 * `:<n>` and only become current when a new control output says so.
 */

import { KeyDeriver, PrivateKey, PublicKey } from '@bsv/sdk'
import {
  PERSONA_ID_MAX,
  SIGMA_IDENTITY_BASKET_PREFIX,
  SIGMA_IDENTITY_COUNTERPARTY,
  SIGMA_IDENTITY_PROTOCOL_ID,
} from './constants'

const RESERVED_BASKETS = new Set(['default', '1sat', 'bsv21', 'index', '1sat-ft'])

const PERSONA_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

export function normalizePersonaId(raw: string): string | null {
  const id = raw.trim().toLowerCase()
  if (!PERSONA_ID_RE.test(id) || id.length > PERSONA_ID_MAX) return null
  if (id.startsWith('sigma-')) return null
  return id
}

/** Display name → stable basket / key id. Empty when the name has no usable chars. */
export function personaIdFromName(name: string): string | null {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, PERSONA_ID_MAX)
    .replace(/-+$/g, '')
  return normalizePersonaId(slug)
}

export function personaKeyId(personaId: string, generation = 0): string {
  const id = normalizePersonaId(personaId)
  if (!id) throw new Error('Sigma identity id must be a short lowercase slug.')
  if (!Number.isInteger(generation) || generation < 0 || generation > 10_000) {
    throw new Error('Sigma identity generation is out of range.')
  }
  return generation === 0 ? id : `${id}:${generation}`
}

/** Dedicated BRC-46 basket. Never `default`, `1sat`, or `bsv21`. */
export function sigmaIdentityBasket(personaId: string): string {
  const id = normalizePersonaId(personaId)
  if (!id) throw new Error('Sigma identity id must be a short lowercase slug.')
  const basket = `${SIGMA_IDENTITY_BASKET_PREFIX}${id}`
  if (RESERVED_BASKETS.has(basket)) {
    throw new Error('Sigma identity basket collides with a reserved basket.')
  }
  return basket
}

export function isSigmaIdentityBasket(basket: string | undefined | null): boolean {
  const name = (basket ?? '').trim().toLowerCase()
  if (!name.startsWith(SIGMA_IDENTITY_BASKET_PREFIX)) return false
  return normalizePersonaId(name.slice(SIGMA_IDENTITY_BASKET_PREFIX.length)) != null
}

function invoiceNumber(keyID: string): string {
  return `${SIGMA_IDENTITY_PROTOCOL_ID[0]}-${SIGMA_IDENTITY_PROTOCOL_ID[1]}-${keyID}`
}

/**
 * Public reconstruction. Anyone with the wallet identity key and the path can
 * do this. Uses the BKDS anyone-point (private key 1), not the root.
 */
export function reconstructSigmaIdentityPublicKey(args: {
  identityKey: string
  personaId: string
  generation?: number
}): PublicKey {
  const keyID = personaKeyId(args.personaId, args.generation ?? 0)
  const identity = PublicKey.fromString(args.identityKey.trim())
  return identity.deriveChild(new PrivateKey(1), invoiceNumber(keyID))
}

export function deriveSigmaIdentityPrivateKey(args: {
  rootKeyHex: string
  personaId: string
  generation?: number
}): PrivateKey {
  const keyID = personaKeyId(args.personaId, args.generation ?? 0)
  const deriver = new KeyDeriver(PrivateKey.fromHex(args.rootKeyHex))
  return deriver.derivePrivateKey(
    [...SIGMA_IDENTITY_PROTOCOL_ID],
    keyID,
    SIGMA_IDENTITY_COUNTERPARTY,
  )
}

/** Address Sigma embeds (library default). Chain-independent pubkey is the proof. */
export function sigmaSigningAddress(key: PrivateKey | PublicKey): string {
  return key.toAddress()
}
