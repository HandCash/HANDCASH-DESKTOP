/**
 * Issuer attestation helpers (BRC-247 direction: BAP-backed).
 *
 * Product rule: one identity hierarchy only.
 *   BAP protocolID = [1, "sigma"], keyID = identity-{N}, basket = bap
 * Issuer stamps are VIN-bound SIGMA tails signed by the current BAP key —
 * not a competing parallel root.
 *
 * Runtime constants below still use the withdrawn parallel-persona path until
 * the wallet migration lands (paths, publish/revoke, Identity UI → BAP).
 * Do not add new callers of the withdrawn [0, "sigma identity"] tree.
 */

/** @deprecated Withdrawn parallel persona protocol — migrate to [1, "sigma"]. */
export const SIGMA_IDENTITY_PROTOCOL_ID = [0, 'sigma identity'] as const

/** @deprecated Withdrawn — BAP uses wallet/self defaults under [1, "sigma"]. */
export const SIGMA_IDENTITY_COUNTERPARTY = 'anyone' as const

/** Target BAP protocol (1sat-sdk / Yours). Use this for new work. */
export const BAP_PROTOCOL_ID = [1, 'sigma'] as const
export const BAP_KEY_PREFIX = 'identity' as const
export const BAP_BASKET = 'bap' as const

export const SIGMA_IDENTITY_MIME = 'application/sigma-identity+json'

export const SIGMA_IDENTITY_VERSION = 1

/** @deprecated Parallel persona baskets withdrawn — legacy reads only. */
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
