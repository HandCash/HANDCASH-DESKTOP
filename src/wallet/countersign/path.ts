import type { CountersignPhase } from './beacon'
import type { AcceptRefusal, CountersignDeploy } from './resolve'

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
