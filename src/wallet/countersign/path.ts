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
 * Who accepts a transfer. A wallet that holds an issuer key accepts its own
 * request in process; anyone else asks the issuer peer to peer.
 */
export type CountersignTransferPath =
  | { path: 'local-acceptor'; assetId: string; amount: bigint; recipient: string }
  | { path: 'remote-acceptor'; assetId: string; amount: bigint; recipient: string; acceptors: string[] }
  | { path: 'refuse'; reason: CountersignRefuse; message: string }

const KEY_RE = /^0[23][0-9a-f]{64}$/

export function chooseCountersignTransferPath(args: {
  deploy: CountersignDeploy | null
  identityKey: string
  recipient: unknown
  amount: unknown
  held: bigint
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
  not_acceptor: 'That key does not accept transfers of this asset.',
}
