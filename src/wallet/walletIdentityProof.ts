/**
 * Application-scoped wallet identity proof recipe built exclusively from the
 * BRC-100 getPublicKey/createSignature methods (BRC-3/42/43).
 */
export const WALLET_IDENTITY_PROOF_PROTOCOL = [2, 'wallet identity proof'] as const
export const WALLET_IDENTITY_PROOF_DOMAIN = 'handcash-wallet-identity-proof'
export const WALLET_IDENTITY_PROOF_VERSION = 1
export const WALLET_IDENTITY_PROOF_MAX_TTL_MS = 5 * 60_000
export const WALLET_IDENTITY_PROOF_CLOCK_SKEW_MS = 60_000

export type WalletIdentityChallenge = {
  domain: typeof WALLET_IDENTITY_PROOF_DOMAIN
  version: typeof WALLET_IDENTITY_PROOF_VERSION
  origin: string
  nonce: string
  issuedAt: number
  expiresAt: number
  purpose: string
}

export type WalletIdentityProofRequest = {
  data: number[]
  protocolID: [number, string]
  keyID: string
  counterparty?: string
  privileged?: boolean
  hashToDirectlySign?: number[]
}

export type WalletIdentityProofValidation =
  | { kind: 'not-identity-proof' }
  | { kind: 'valid'; challenge: WalletIdentityChallenge }
  | { kind: 'invalid'; reason: string }

export function walletIdentityProofKeyID(origin: string): string {
  return `identity-proof:${origin}`
}

export function serializeWalletIdentityChallenge(
  challenge: WalletIdentityChallenge,
): string {
  return JSON.stringify({
    domain: challenge.domain,
    version: challenge.version,
    origin: challenge.origin,
    nonce: challenge.nonce,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
    purpose: challenge.purpose,
  })
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function isIdentityProofProtocol(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value[0] === WALLET_IDENTITY_PROOF_PROTOCOL[0] &&
    value[1] === WALLET_IDENTITY_PROOF_PROTOCOL[1]
  )
}

function validNonce(value: unknown): value is string {
  // 22 unpadded base64url characters are enough to encode 128 random bits.
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{22,128}$/.test(value)) {
    return false
  }
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(
      Math.ceil(value.length / 4) * 4,
      '=',
    )
    return atob(padded).length >= 16
  } catch {
    return false
  }
}

function decodeData(value: unknown): string | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 2048 ||
    !value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  ) {
    return null
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(value))
  } catch {
    return null
  }
}

/**
 * Recognizes the advertised recipe and validates its canonical, origin-bound
 * challenge before the wallet asks for permission or signs anything.
 */
export function validateWalletIdentityProofRequest(
  args: unknown,
  expectedOrigin: string,
  now = Date.now(),
): WalletIdentityProofValidation {
  const request = asRecord(args)
  if (!request || !isIdentityProofProtocol(request.protocolID)) {
    return { kind: 'not-identity-proof' }
  }
  if (!expectedOrigin || expectedOrigin === 'unknown-app') {
    return { kind: 'invalid', reason: 'Identity proofs require an authenticated application origin.' }
  }
  if (request.hashToDirectlySign !== undefined) {
    return { kind: 'invalid', reason: 'Identity proofs must sign the canonical challenge bytes, not a hash.' }
  }
  if (request.privileged === true) {
    return { kind: 'invalid', reason: 'Identity proofs must not request privileged key access.' }
  }
  if (request.counterparty !== 'anyone') {
    return { kind: 'invalid', reason: 'Identity proofs require counterparty "anyone" for public verification.' }
  }
  if (request.keyID !== walletIdentityProofKeyID(expectedOrigin)) {
    return { kind: 'invalid', reason: 'Identity proof keyID does not match the requesting origin.' }
  }

  const text = decodeData(request.data)
  if (text == null) {
    return { kind: 'invalid', reason: 'Identity proof data must be a bounded UTF-8 byte array.' }
  }

  let parsed: Record<string, unknown>
  try {
    const value = JSON.parse(text)
    const record = asRecord(value)
    if (!record) throw new Error('not an object')
    parsed = record
  } catch {
    return { kind: 'invalid', reason: 'Identity proof data must be canonical JSON.' }
  }

  const keys = Object.keys(parsed)
  const expectedKeys = ['domain', 'version', 'origin', 'nonce', 'issuedAt', 'expiresAt', 'purpose']
  if (keys.length !== expectedKeys.length || expectedKeys.some((key) => !keys.includes(key))) {
    return { kind: 'invalid', reason: 'Identity proof challenge has unknown or missing fields.' }
  }
  if (
    parsed.domain !== WALLET_IDENTITY_PROOF_DOMAIN ||
    parsed.version !== WALLET_IDENTITY_PROOF_VERSION
  ) {
    return { kind: 'invalid', reason: 'Unsupported identity proof domain or version.' }
  }
  if (parsed.origin !== expectedOrigin) {
    return { kind: 'invalid', reason: 'Identity proof challenge origin does not match the requester.' }
  }
  if (!validNonce(parsed.nonce)) {
    return { kind: 'invalid', reason: 'Identity proof nonce must contain at least 128 bits of base64url data.' }
  }
  if (
    typeof parsed.issuedAt !== 'number' ||
    !Number.isSafeInteger(parsed.issuedAt) ||
    typeof parsed.expiresAt !== 'number' ||
    !Number.isSafeInteger(parsed.expiresAt)
  ) {
    return { kind: 'invalid', reason: 'Identity proof timestamps must be integer Unix milliseconds.' }
  }
  if (
    typeof parsed.purpose !== 'string' ||
    parsed.purpose !== parsed.purpose.trim() ||
    parsed.purpose.length < 1 ||
    parsed.purpose.length > 120 ||
    /[\u0000-\u001f\u007f]/.test(parsed.purpose)
  ) {
    return { kind: 'invalid', reason: 'Identity proof purpose must be 1-120 printable characters.' }
  }

  const challenge = parsed as WalletIdentityChallenge
  if (challenge.expiresAt <= challenge.issuedAt) {
    return { kind: 'invalid', reason: 'Identity proof expiry must be after issuance.' }
  }
  if (challenge.expiresAt - challenge.issuedAt > WALLET_IDENTITY_PROOF_MAX_TTL_MS) {
    return { kind: 'invalid', reason: 'Identity proof lifetime exceeds five minutes.' }
  }
  if (challenge.issuedAt > now + WALLET_IDENTITY_PROOF_CLOCK_SKEW_MS) {
    return { kind: 'invalid', reason: 'Identity proof was issued too far in the future.' }
  }
  if (challenge.expiresAt < now - WALLET_IDENTITY_PROOF_CLOCK_SKEW_MS) {
    return { kind: 'invalid', reason: 'Identity proof challenge has expired.' }
  }
  if (serializeWalletIdentityChallenge(challenge) !== text) {
    return { kind: 'invalid', reason: 'Identity proof challenge is not canonically serialized.' }
  }
  return { kind: 'valid', challenge }
}

/** Purpose is shown only when the request is structurally canonical. */
export function walletIdentityProofPurpose(args: unknown): string | null {
  const request = asRecord(args)
  if (!request || !isIdentityProofProtocol(request.protocolID)) return null
  const text = decodeData(request.data)
  if (text == null) return null
  try {
    const parsed = JSON.parse(text) as WalletIdentityChallenge
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Object.keys(parsed).length !== 7 ||
      parsed.domain !== WALLET_IDENTITY_PROOF_DOMAIN ||
      parsed.version !== WALLET_IDENTITY_PROOF_VERSION ||
      typeof parsed.origin !== 'string' ||
      !validNonce(parsed.nonce) ||
      !Number.isSafeInteger(parsed.issuedAt) ||
      !Number.isSafeInteger(parsed.expiresAt) ||
      typeof parsed.purpose !== 'string' ||
      parsed.purpose !== parsed.purpose.trim() ||
      parsed.purpose.length < 1 ||
      parsed.purpose.length > 120 ||
      /[\u0000-\u001f\u007f]/.test(parsed.purpose) ||
      serializeWalletIdentityChallenge(parsed) !== text
    ) {
      return null
    }
    return parsed.purpose
  } catch {
    return null
  }
}
