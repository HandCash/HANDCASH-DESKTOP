/**
 * Sigma identity — portable personas on BRC-100, not the wallet root.
 *
 * Root identity is the BRC-100 identity key. A BRC-169 handle is a claim on
 * that key. A Sigma identity is a separate BKDS child used to attest 1Sat and
 * BSV-21 issuances. Spending its control output revokes it. It never replaces
 * the root key or the handle.
 *
 * Derivation is BRC-42 public (security level 0, counterparty `anyone`) so any
 * indexer with the wallet identity key and the persona id can reconstruct the
 * signing key. The root private key is not required to verify, and is never
 * placed in an inscription.
 */

/** BRC-42 / BRC-43 protocol. Security level 0 = publicly derivable. */
export const SIGMA_IDENTITY_PROTOCOL_ID = [0, 'sigma identity'] as const

export const SIGMA_IDENTITY_COUNTERPARTY = 'anyone' as const

export const SIGMA_IDENTITY_MIME = 'application/sigma-identity+json'

export const SIGMA_IDENTITY_VERSION = 1

export const SIGMA_IDENTITY_BASKET_PREFIX = 'sigma-'

/** ASCII "SIGMA" push — present on a Sigma tail. */
export const SIGMA_MARKER_HEX = '5349474d41'

export const NAME_MAX = 40
export const ABOUT_MAX = 80
export const PERSONA_ID_MAX = 32

/** Off-chain challenge window. Same order as BRC-138, different statement. */
export const CHALLENGE_VALIDITY_MS = 120_000
export const CHALLENGE_CLOCK_SKEW_MS = 30_000

export const P2PKH_UNLOCK_LENGTH = 108
