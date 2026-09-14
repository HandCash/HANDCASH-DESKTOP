/**
 * BRC-138 single-use authentication proof, produced only through BRC-100
 * `createSignature` / `getPublicKey`. No HandCash challenge recipe.
 *
 * https://bsv.brc.dev/peer-to-peer/0138.md
 *
 * The BRC-42/43 child that signs is not the identity. The authenticated subject
 * is `data.identityKey`, and it must be this wallet's identity key.
 */
export const BRC138_AUTH_PROOF_PROTOCOL = [2, 'bsv auth proof'] as const
/** Withdrawn HandCash recipe. Refused so it cannot be signed as a generic signature. */
export const WITHDRAWN_IDENTITY_PROOF_PROTOCOL = [2, 'wallet identity proof'] as const

export const BRC138_VALIDITY_WINDOW_MS = 120_000
export const BRC138_CLOCK_SKEW_MS = 30_000

const COMPRESSED_PUBKEY = /^(02|03)[0-9a-fA-F]{64}$/
const ACTION_RE = /^[A-Za-z0-9 ]+$/

export type Brc138ProofData = {
  action: string
  identityKey: string
  expiresAt: number
  nonce: string
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
  | { kind: 'valid'; proof: Brc138ProofData }
  | { kind: 'invalid'; reason: string }

/** Canonical signed statement: action, identityKey, expiresAt, nonce, line-feed separated. */
export function encodeBrc138Proof(proof: Brc138ProofData): string {
  return `${proof.action}\n${proof.identityKey}\n${proof.expiresAt}\n${proof.nonce}`
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function protocolName(value: unknown): string | null {
  if (!Array.isArray(value) || value.length !== 2 || value[0] !== 2) return null
  return typeof value[1] === 'string' ? value[1] : null
}

function decodeData(value: unknown): string | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 512 ||
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

/** Base64 of exactly 32 bytes, as required by BRC-138. */
export function isBrc138Nonce(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 42 || value.length > 48) return false
  if (!/^[A-Za-z0-9+/_-]+=*$/.test(value)) return false
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(
      Math.ceil(value.length / 4) * 4,
      '=',
    )
    const raw = atob(padded)
    return raw.length === 32
  } catch {
    return false
  }
}

function parseCanonicalProof(text: string): Brc138ProofData | null {
  const parts = text.split('\n')
  if (parts.length !== 4) return null
  const [action, identityKey, expiresRaw, nonce] = parts
  if (!action || !ACTION_RE.test(action) || action !== action.trim()) return null
  if (!identityKey || !COMPRESSED_PUBKEY.test(identityKey)) return null
  if (!expiresRaw || !/^[0-9]+$/.test(expiresRaw)) return null
  const expiresAt = Number(expiresRaw)
  if (!Number.isSafeInteger(expiresAt)) return null
  if (!isBrc138Nonce(nonce)) return null
  const proof = { action, identityKey, expiresAt, nonce }
  if (encodeBrc138Proof(proof) !== text) return null
  return proof
}

function structuralProof(
  args: unknown,
): { kind: 'not' } | { kind: 'withdrawn' } | { kind: 'invalid'; reason: string } | { kind: 'ok'; proof: Brc138ProofData; counterparty: string } {
  const request = asRecord(args)
  if (!request) return { kind: 'not' }
  const protocol = protocolName(request.protocolID)
  if (protocol === WITHDRAWN_IDENTITY_PROOF_PROTOCOL[1]) return { kind: 'withdrawn' }
  if (protocol !== BRC138_AUTH_PROOF_PROTOCOL[1]) return { kind: 'not' }
  if (request.hashToDirectlySign !== undefined) {
    return { kind: 'invalid', reason: 'BRC-138 proofs must sign the canonical statement, not a hash.' }
  }
  if (request.privileged === true) {
    return { kind: 'invalid', reason: 'BRC-138 proofs must not request privileged key access.' }
  }
  const counterparty = request.counterparty
  if (typeof counterparty !== 'string' || !COMPRESSED_PUBKEY.test(counterparty)) {
    return {
      kind: 'invalid',
      reason: 'BRC-138 proofs must be signed toward the verifier identity key.',
    }
  }
  const text = decodeData(request.data)
  if (text == null) {
    return { kind: 'invalid', reason: 'BRC-138 proof data must be the canonical UTF-8 statement.' }
  }
  const proof = parseCanonicalProof(text)
  if (!proof) {
    return { kind: 'invalid', reason: 'BRC-138 proof statement is not canonical.' }
  }
  if (request.keyID !== proof.nonce) {
    return { kind: 'invalid', reason: 'BRC-138 keyID must be the proof nonce.' }
  }
  return { kind: 'ok', proof, counterparty }
}

/**
 * Validates a `createSignature` request that uses the BRC-138 protocol.
 * Unrelated signatures return `not-identity-proof` and are left alone.
 */
export function validateWalletIdentityProofRequest(
  args: unknown,
  expectedIdentityKey: string | undefined,
  now = Date.now(),
): WalletIdentityProofValidation {
  const parsed = structuralProof(args)
  if (parsed.kind === 'not') return { kind: 'not-identity-proof' }
  if (parsed.kind === 'withdrawn') {
    return {
      kind: 'invalid',
      reason: 'The HandCash wallet identity proof recipe is withdrawn. Use BRC-138.',
    }
  }
  if (parsed.kind === 'invalid') return parsed

  const expected = expectedIdentityKey?.trim().toLowerCase() ?? ''
  if (!COMPRESSED_PUBKEY.test(expected)) {
    return { kind: 'invalid', reason: 'BRC-138 proofs require an unlocked wallet identity key.' }
  }
  if (parsed.proof.identityKey.toLowerCase() !== expected) {
    return { kind: 'invalid', reason: 'BRC-138 identityKey must be this wallet identity key.' }
  }
  if (parsed.counterparty.toLowerCase() === expected) {
    return { kind: 'invalid', reason: 'BRC-138 proofs must be addressed to the verifier, not this wallet.' }
  }

  const { expiresAt } = parsed.proof
  if (!(now < expiresAt)) {
    return { kind: 'invalid', reason: 'BRC-138 proof has expired.' }
  }
  if (expiresAt - now > BRC138_VALIDITY_WINDOW_MS + BRC138_CLOCK_SKEW_MS) {
    return { kind: 'invalid', reason: 'BRC-138 proof lifetime exceeds the validity window.' }
  }
  return { kind: 'valid', proof: parsed.proof }
}

/** Action is shown only when the statement is structurally canonical. */
export function walletIdentityProofPurpose(args: unknown): string | null {
  const parsed = structuralProof(args)
  if (parsed.kind !== 'ok') return null
  return parsed.proof.action
}
