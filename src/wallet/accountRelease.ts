/**
 * Moving a vault account on demand (draft BRC-249, "Moving on demand").
 *
 * The install that wants an account another install holds posts a signed
 * `release-request` on the account's holding channel: box `account-holding`
 * of the account's own identity key. A live holder answers `release-accept`
 * at once and releases; one that does not answer within the answer window is
 * offline, and the account is taken from it. Both messages are signed by the
 * account root, so every install of the vault can produce them and the box
 * host cannot.
 *
 * This module is the wire format and the holder's decision. Transport lives
 * in `messageTransport.ts`, orchestration in `accountMove.ts`.
 */
import { BigNumber, PrivateKey, PublicKey, Random, Signature, Utils } from '@bsv/sdk'
import type { AccountHolding } from './accountHolding'
import { signIdentityText } from './messageboxAuth'

/** BRC-33 box on the account's own identity key. */
export const HOLDING_BOX = 'account-holding'
/** No accept within this long: the holder is offline. */
export const ANSWER_WINDOW_MS = 10_000
/** After an accept, how long the holder has to write `released`. */
export const RELEASE_WINDOW_MS = 2 * 60_000
/** A holder ignores requests older than this. */
export const REQUEST_MAX_AGE_MS = 10 * 60_000

export type ReleaseRequest = {
  v: 1
  type: 'release-request'
  identityKey: string
  deviceId: string
  seq: number
  nonce: string
  at: number
  signature: string
}

export type ReleaseAccept = {
  v: 1
  type: 'release-accept'
  identityKey: string
  deviceId: string
  nonce: string
  at: number
  signature: string
}

export type HoldingMessage = ReleaseRequest | ReleaseAccept

function identityKeyOf(rootKeyHex: string): string {
  return PrivateKey.fromHex(rootKeyHex.trim()).toPublicKey().toString().toLowerCase()
}

export function releaseRequestPreimage(fields: Omit<ReleaseRequest, 'v' | 'type' | 'signature'>): string {
  return [
    'account-release-request',
    'v1',
    fields.identityKey,
    fields.deviceId,
    String(fields.seq),
    fields.nonce,
    String(fields.at),
  ].join('\n')
}

export function releaseAcceptPreimage(fields: Omit<ReleaseAccept, 'v' | 'type' | 'signature'>): string {
  return [
    'account-release-accept',
    'v1',
    fields.identityKey,
    fields.deviceId,
    fields.nonce,
    String(fields.at),
  ].join('\n')
}

export function signReleaseRequest(
  rootKeyHex: string,
  fields: { deviceId: string; seq: number; nonce?: string; at?: number },
): ReleaseRequest {
  const unsigned = {
    identityKey: identityKeyOf(rootKeyHex),
    deviceId: fields.deviceId,
    seq: fields.seq,
    nonce: fields.nonce ?? Utils.toHex(Random(16)),
    at: fields.at ?? Date.now(),
  }
  const { signature } = signIdentityText(rootKeyHex, releaseRequestPreimage(unsigned))
  return { v: 1, type: 'release-request', ...unsigned, signature }
}

export function signReleaseAccept(
  rootKeyHex: string,
  fields: { deviceId: string; nonce: string; at?: number },
): ReleaseAccept {
  const unsigned = {
    identityKey: identityKeyOf(rootKeyHex),
    deviceId: fields.deviceId,
    nonce: fields.nonce,
    at: fields.at ?? Date.now(),
  }
  const { signature } = signIdentityText(rootKeyHex, releaseAcceptPreimage(unsigned))
  return { v: 1, type: 'release-accept', ...unsigned, signature }
}

function verifyCompact(identityKey: string, text: string, signatureHex: string): boolean {
  try {
    const compact = Utils.toArray(signatureHex, 'hex')
    if (compact.length !== 64) return false
    const sig = new Signature(
      new BigNumber(Utils.toHex(compact.slice(0, 32)), 16),
      new BigNumber(Utils.toHex(compact.slice(32, 64)), 16),
    )
    return PublicKey.fromString(identityKey).verify(Utils.toArray(text, 'utf8'), sig)
  } catch {
    return false
  }
}

function validDeviceId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
}

function validNonce(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value)
}

/** A request or accept for `identityKey`, signed by it; null for anything else. */
export function parseHoldingMessage(body: string, identityKey: string): HoldingMessage | null {
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  const owner = identityKey.trim().toLowerCase()
  if (m.v !== 1 || m.identityKey !== owner) return null
  if (!validDeviceId(m.deviceId) || !validNonce(m.nonce)) return null
  if (!Number.isSafeInteger(m.at) || (m.at as number) < 0) return null
  if (typeof m.signature !== 'string') return null
  if (m.type === 'release-request') {
    if (!Number.isSafeInteger(m.seq) || (m.seq as number) < 0) return null
    const request = m as unknown as ReleaseRequest
    return verifyCompact(owner, releaseRequestPreimage(request), request.signature) ? request : null
  }
  if (m.type === 'release-accept') {
    const accept = m as unknown as ReleaseAccept
    return verifyCompact(owner, releaseAcceptPreimage(accept), accept.signature) ? accept : null
  }
  return null
}

/** What a holder does with one request from its box. */
export type RequestAnswer =
  /** Accept and release. */
  | { kind: 'accept' }
  /** Consumed without acting: a later move overtook it, or it is too old. */
  | { kind: 'drop'; reason: 'overtaken' | 'expired' }
  /** Not this install's to consume: it does not hold the account, or its own record is behind. */
  | { kind: 'leave'; reason: 'not-holder' | 'newer-record' }

export function decideRequestAnswer(args: {
  request: ReleaseRequest
  local: AccountHolding
  now: number
}): RequestAnswer {
  const { request, local, now } = args
  if (local.kind !== 'here') return { kind: 'leave', reason: 'not-holder' }
  if (request.seq > local.seq) return { kind: 'leave', reason: 'newer-record' }
  if (request.seq < local.seq) return { kind: 'drop', reason: 'overtaken' }
  if (now - request.at > REQUEST_MAX_AGE_MS || request.at - now > REQUEST_MAX_AGE_MS) {
    return { kind: 'drop', reason: 'expired' }
  }
  return { kind: 'accept' }
}
