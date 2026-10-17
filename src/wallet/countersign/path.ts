import type { CountersignPhase } from './beacon'
import type { AcceptRefusal, CountersignDeploy } from './resolve'
import type { KeySet } from './script'

/** Every way an issue or transfer of a countersigned asset ends without a transaction. */
export type CountersignRefuse =
  | 'bad-asset-args'
  | 'unknown-asset'
  | 'bad-recipient'
  | 'bad-amount'
  | 'item-amount'
  | 'insufficient'
  | 'acceptor-refused'
  | 'acceptor-silent'
  | 'invalid-acceptance'
  | 'not-issuer'
  | 'not-custodian'
  | 'asset-live'
  | 'asset-ended'
  | 'asset-released'
  | 'phase-unknown'
  | 'release-required'
  | 'release-issuer-only'

export class CountersignError extends Error {
  readonly code: CountersignRefuse
  readonly acceptorReason?: AcceptRefusal
  constructor(code: CountersignRefuse, message: string, acceptorReason?: AcceptRefusal) {
    super(message)
    this.name = 'CountersignError'
    this.code = code
    if (acceptorReason) this.acceptorReason = acceptorReason
  }
}

/**
 * Who countersigns a transfer. While the asset is live, a wallet that holds an
 * issuer key accepts its own request in process and anyone else asks the
 * issuer peer to peer. Once released, the holder countersigns with the
 * disclosed release keys and funds the fee itself; no request is sent.
 */
export type CountersignTransferPath =
  | { path: 'local-acceptor'; assetId: string; amount: bigint; recipient: string }
  | { path: 'remote-acceptor'; assetId: string; amount: bigint; recipient: string; acceptors: string[] }
  | { path: 'released'; assetId: string; amount: bigint; recipient: string; keys: string[] }
  | { path: 'refuse'; reason: CountersignRefuse; message: string }

const KEY_RE = /^0[23][0-9a-f]{64}$/

export function chooseCountersignTransferPath(args: {
  deploy: CountersignDeploy | null
  identityKey: string
  recipient: unknown
  amount: unknown
  held: bigint
  /** Last phase this wallet read; absent counts as live. */
  phase?: CountersignPhase
}): CountersignTransferPath {
  if (!args.deploy) {
    return { path: 'refuse', reason: 'unknown-asset', message: 'This wallet has no deploy body for that asset.' }
  }
  const recipient = typeof args.recipient === 'string' ? args.recipient.trim().toLowerCase() : ''
  if (!KEY_RE.test(recipient)) {
    return { path: 'refuse', reason: 'bad-recipient', message: 'The recipient must be an identity public key.' }
  }
  const raw = args.amount == null && args.deploy.kind === 'item' ? '1' : String(args.amount ?? '').trim()
  if (!/^\d+$/.test(raw) || BigInt(raw) <= 0n) {
    return { path: 'refuse', reason: 'bad-amount', message: 'The amount must be a positive whole number of units.' }
  }
  const amount = BigInt(raw)
  if (args.deploy.kind === 'item' && amount !== 1n) {
    return { path: 'refuse', reason: 'item-amount', message: 'An item moves whole: the amount is 1.' }
  }
  if (amount > args.held) {
    return {
      path: 'refuse',
      reason: 'insufficient',
      message: `This wallet holds ${args.held} of that asset, not ${amount}.`,
    }
  }
  const self = args.identityKey.toLowerCase()
  const base = { assetId: args.deploy.assetId, amount, recipient }
  if (args.phase?.phase === 'released') return { path: 'released', ...base, keys: args.phase.keys }
  if (args.phase?.phase === 'ended') {
    return {
      path: 'refuse',
      reason: 'asset-ended',
      message: 'The issuer has stopped accepting this asset. It moves again once its release keys are published.',
    }
  }
  return args.deploy.sets.issuer.keys.includes(self)
    ? { path: 'local-acceptor', ...base }
    : { path: 'remote-acceptor', ...base, acceptors: args.deploy.sets.issuer.keys }
}

/**
 * Who can release an asset once its issuer is gone. `independent`: keys the
 * issuer does not hold meet the threshold, so holders are freed even if the
 * issuer vanishes. `issuer-only`: only the issuer's own release key, chosen
 * explicitly with `release: 'self'`; the asset freezes for good if the issuer
 * stops without releasing it. Anything else refuses before signing.
 */
export type ReleaseCustody =
  | { custody: 'independent'; release: KeySet }
  | { custody: 'issuer-only'; release: KeySet }
  | { custody: 'refuse'; reason: CountersignRefuse; message: string }

export function chooseReleaseCustody(args: {
  release: unknown
  /** Keys the issuer holds: its issuer keys and its own release key. */
  issuerHeld: string[]
  ownRelease: KeySet
}): ReleaseCustody {
  if (args.release === 'self') return { custody: 'issuer-only', release: args.ownRelease }
  if (args.release == null) {
    return {
      custody: 'refuse',
      reason: 'release-required',
      message:
        'Name release custodians (their releaseKey) who can free holders without you, or pass release: "self" to accept that the asset freezes for good if your wallet stops without releasing it.',
    }
  }
  if (typeof args.release !== 'object') {
    return { custody: 'refuse', reason: 'bad-asset-args', message: 'release must be "self" or { threshold, keys }.' }
  }
  const raw = args.release as { threshold?: unknown; keys?: unknown }
  const keys = Array.isArray(raw.keys) ? raw.keys.map((k) => String(k).trim().toLowerCase()) : []
  const threshold = Number(raw.threshold)
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > keys.length || keys.some((k) => !KEY_RE.test(k))) {
    return {
      custody: 'refuse',
      reason: 'bad-asset-args',
      message: 'release needs compressed public keys and a threshold from 1 to their count.',
    }
  }
  const held = new Set(args.issuerHeld.map((k) => k.toLowerCase()))
  const independent = new Set(keys.filter((k) => !held.has(k)))
  if (independent.size < threshold) {
    return {
      custody: 'refuse',
      reason: 'release-issuer-only',
      message: `Custodians other than you must be able to release on their own: ${threshold} needed, ${independent.size} named. Otherwise the asset freezes for good if your wallet stops.`,
    }
  }
  return { custody: 'independent', release: { threshold, keys } }
}

export const ACCEPT_REFUSAL_COPY: Record<AcceptRefusal, string> = {
  unknown_input: 'The issuer has no record of accepting those units.',
  spent: 'Those units are already part of another transfer.',
  invalid: 'The issuer found the transfer malformed.',
  frozen: 'The issuer has frozen these units.',
  recipient: 'The issuer does not accept that recipient.',
  limit: 'The transfer is over the issuer’s limit.',
  fee: 'The issuer asks for a fee in tokens.',
  policy: 'The issuer’s policy refuses this transfer.',
  not_acceptor: 'The issuer no longer accepts transfers of this asset.',
}
