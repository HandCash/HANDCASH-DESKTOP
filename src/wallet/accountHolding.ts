/**
 * Which install holds a vault account (BRC-208 accounts across devices;
 * draft BRC-249, `docs/bsva/brcs/wallet/0249.md`).
 *
 * Two installs that open one account are two spenders of one key, and nothing
 * on the spend path can keep them apart: the per-payment spend lease that
 * tried cost ~1.7s a payment and was removed (1.3.376). Devices that share a
 * vault master hold different accounts instead. Holding is local state: the
 * spend guard reads it from this device's account store and never touches the
 * network. The holder record beside each account's history backup
 * (`/v1/wallets/<identityKey>/holder.json`, `accountHolderRecord.ts`) is how
 * other installs learn it, and it changes only on an explicit create, take or
 * release.
 *
 * The record is signed by the account root and its `seq` only grows. A reader
 * ignores a record older than the one it last acted on, so a host can withhold
 * a change but cannot forge or roll one back.
 */
import { BigNumber, PrivateKey, PublicKey, Signature, Utils } from '@bsv/sdk'
import { signIdentityText } from './messageboxAuth'

export type AccountHolding =
  /** This install may open and spend the account. `seq` 0: never published. */
  | { kind: 'here'; seq: number }
  /** Another install holds it, or released it (`deviceId` null). */
  | { kind: 'elsewhere'; seq: number; deviceId: string | null }

export const UNPUBLISHED_HERE: AccountHolding = { kind: 'here', seq: 0 }
export const UNKNOWN_ELSEWHERE: AccountHolding = { kind: 'elsewhere', seq: 0, deviceId: null }

export type HolderState = 'held' | 'released'

export type HolderRecord = {
  v: 1
  identityKey: string
  deviceId: string
  state: HolderState
  seq: number
  at: number
  signature: string
}

export type HolderRead =
  | { kind: 'record'; record: HolderRecord; etag: string | null }
  | { kind: 'absent' }
  /** No backup host, or a host without holder records. */
  | { kind: 'unsupported' }
  | { kind: 'unreachable'; reason: string }

export type HolderWrite =
  | { kind: 'written'; record: HolderRecord }
  /** Someone wrote first: re-read before deciding again. */
  | { kind: 'conflict' }
  | { kind: 'unsupported' }
  | { kind: 'unreachable'; reason: string }

/** What a check does with one account. */
export type HoldingStep =
  | { kind: 'keep' }
  | { kind: 'adopt'; holding: AccountHolding }
  | { kind: 'publish'; seq: number; condition: HolderCondition }

export type HolderCondition = { create: true } | { create: false; etag: string | null }

export type AccountKeys = { identityKey: string; rootKeyHex: string }

export function holderRecordPreimage(fields: Omit<HolderRecord, 'v' | 'signature'>): string {
  return [
    'account-holder',
    'v1',
    fields.identityKey,
    fields.deviceId,
    fields.state,
    String(fields.seq),
    String(fields.at),
  ].join('\n')
}

export function signHolderRecord(
  rootKeyHex: string,
  fields: { deviceId: string; state: HolderState; seq: number; at?: number },
): HolderRecord {
  const unsigned = {
    identityKey: PrivateKey.fromHex(rootKeyHex.trim()).toPublicKey().toString().toLowerCase(),
    deviceId: fields.deviceId,
    state: fields.state,
    seq: fields.seq,
    at: fields.at ?? Date.now(),
  }
  const { signature } = signIdentityText(rootKeyHex, holderRecordPreimage(unsigned))
  return { v: 1, ...unsigned, signature }
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

/** A record for `identityKey` signed by it, or null. */
export function parseHolderRecord(raw: unknown, identityKey: string): HolderRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<HolderRecord>
  const owner = identityKey.trim().toLowerCase()
  if (r.v !== 1 || r.identityKey !== owner) return null
  if (typeof r.deviceId !== 'string' || !r.deviceId || r.deviceId.length > 128) return null
  if (r.state !== 'held' && r.state !== 'released') return null
  if (!Number.isSafeInteger(r.seq) || (r.seq as number) < 1) return null
  if (!Number.isSafeInteger(r.at) || (r.at as number) < 0) return null
  if (typeof r.signature !== 'string') return null
  const record = r as HolderRecord
  return verifyCompact(owner, holderRecordPreimage(record), record.signature) ? record : null
}

/** This install's holding once a record at least as new as it is known. */
export function holdingFromRecord(record: HolderRecord, deviceId: string): AccountHolding {
  if (record.state === 'held' && record.deviceId === deviceId) return { kind: 'here', seq: record.seq }
  return {
    kind: 'elsewhere',
    seq: record.seq,
    deviceId: record.state === 'held' ? record.deviceId : null,
  }
}

/**
 * Reconcile local holding with what the host says.
 *
 * `takeover`: this install replaced the previous one (a restore that did not
 * keep the other device), so every account it holds is claimed from whoever
 * the record names.
 */
export function decideHoldingStep(args: {
  local: AccountHolding
  read: HolderRead
  deviceId: string
  takeover: boolean
}): HoldingStep {
  const { local, read, deviceId, takeover } = args
  if (read.kind === 'unsupported' || read.kind === 'unreachable') return { kind: 'keep' }
  if (read.kind === 'absent') {
    // A vanished record leaves a released or foreign account where it was.
    return local.kind === 'here'
      ? { kind: 'publish', seq: local.seq + 1, condition: { create: true } }
      : { kind: 'keep' }
  }
  const { record, etag } = read
  const mine = record.state === 'held' && record.deviceId === deviceId
  if (local.kind === 'here' && takeover && !mine) {
    return {
      kind: 'publish',
      seq: Math.max(record.seq, local.seq) + 1,
      condition: { create: false, etag },
    }
  }
  if (record.seq < local.seq) {
    // Our newer write is missing; republish it rather than act on an older one.
    return local.kind === 'here'
      ? { kind: 'publish', seq: local.seq + 1, condition: { create: false, etag } }
      : { kind: 'keep' }
  }
  const next = holdingFromRecord(record, deviceId)
  return sameHolding(next, local) ? { kind: 'keep' } : { kind: 'adopt', holding: next }
}

export function sameHolding(a: AccountHolding, b: AccountHolding): boolean {
  if (a.kind !== b.kind || a.seq !== b.seq) return false
  return a.kind === 'here' || a.deviceId === (b as typeof a).deviceId
}
