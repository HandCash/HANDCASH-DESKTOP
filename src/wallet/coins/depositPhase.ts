import { COIN_INFO, type CoinChain } from './coinChains'

/**
 * Where a received coin stands, and who says so, on any chain the wallet
 * holds. Confirmations are only ever counted on this wallet's own header chain
 * for the coin (`ltc/headers.ts`); a source may say a coin waits for a block
 * or which block holds it, never how deep it is. Every phase carries the time
 * it was last established, so a stale answer is shown as stale rather than as
 * the present.
 *
 * - `unconfirmed`: a source reports the transaction, not yet in a block.
 * - `confirming`: in block `height`; `confirmations` counted on this chain
 *   (0 while this chain has not reached that block).
 * - `movable`: buried the chain's depth on this chain; proof recorded.
 * - `unchecked`: the chain could not be read since `since`; `last` is the last
 *   count this chain established, if any.
 * - `missing`: no source knows the transaction since `since`.
 * - `abandoned`: missing for long enough to say so. Presentation only: its
 *   coin is never spent, and nothing proves it never will.
 */
export type CoinDepositPhase =
  | { kind: 'unconfirmed'; checkedAt: number }
  | { kind: 'confirming'; confirmations: number; needed: number; height: number; checkedAt: number }
  | { kind: 'movable'; height?: number; checkedAt?: number }
  | { kind: 'unchecked'; since: number; last?: { confirmations: number; needed: number; height: number; checkedAt: number } }
  | { kind: 'missing'; since: number }
  | { kind: 'abandoned'; since: number }

export type CoinDepositView = {
  txid: string
  vout: number
  litoshi: string
  at: number
  phase: CoinDepositPhase
}

export function depositWaiting(phase: CoinDepositPhase): boolean {
  return phase.kind !== 'movable'
}

/** Confirmations this wallet's own chain has counted, and how many `chain` needs. */
export function depositCount(chain: CoinChain, phase: CoinDepositPhase): { counted: number; needed: number } {
  const depth = COIN_INFO[chain].confirmations
  switch (phase.kind) {
    case 'confirming':
      return { counted: Math.min(phase.confirmations, phase.needed), needed: phase.needed }
    case 'movable':
      return { counted: depth, needed: depth }
    case 'unchecked':
      return phase.last ? { counted: Math.min(phase.last.confirmations, phase.last.needed), needed: phase.last.needed } : { counted: 0, needed: depth }
    default:
      return { counted: 0, needed: depth }
  }
}

/** The block holding a coin, once this wallet has located it. */
export function depositBlock(phase: CoinDepositPhase | undefined): number | undefined {
  return phase?.kind === 'confirming' || phase?.kind === 'movable' ? phase.height : phase?.kind === 'unchecked' ? phase.last?.height : undefined
}

const clock = (at: number) => {
  const when = new Date(at)
  const time = when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return when.toDateString() === new Date().toDateString()
    ? time
    : `${when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`
}

export type CoinDepositCopy = {
  /** What the coin's state is, in a few words. */
  status: string
  /** Who established it and when. */
  source: string
  /** A labelled time estimate, only while blocks are what it waits for. */
  estimate: string | null
}

export function describeDeposit(chain: CoinChain, phase: CoinDepositPhase): CoinDepositCopy {
  const { label, confirmations: depth, blockMinutes } = COIN_INFO[chain]
  const minutes = (blocks: number) => {
    const m = Math.max(1, Math.round(blocks * blockMinutes))
    return m >= 60 ? `${Math.round(m / 6) / 10} h` : `${m} min`
  }
  const pace = `if blocks keep ${label}'s ${blockMinutes}-minute pace`
  switch (phase.kind) {
    case 'unconfirmed':
      return {
        status: `Waiting for its first ${label} block`,
        source: `A ${label} server reports it unconfirmed · ${clock(phase.checkedAt)}`,
        estimate: depth > 1 ? `About ${minutes(depth - 1)} after its first block, ${pace}` : null,
      }
    case 'confirming': {
      const remaining = phase.needed - Math.min(phase.confirmations, phase.needed)
      return phase.confirmations > 0
        ? {
            status: `${phase.confirmations} of ${phase.needed} ${label} confirmations`,
            source: `Counted on this wallet's own ${label} header chain · ${clock(phase.checkedAt)}`,
            estimate: `About ${minutes(remaining)} more, ${pace}`,
          }
        : {
            status: `In ${label} block ${phase.height.toLocaleString()}`,
            source: `This wallet's header chain has not reached that block yet · ${clock(phase.checkedAt)}`,
            estimate: `About ${minutes(remaining)}, ${pace}`,
          }
    }
    case 'movable':
      return {
        status: 'Spendable',
        source: `${depth} or more confirmations on this wallet's own ${label} header chain`,
        estimate: null,
      }
    case 'unchecked':
      return {
        status: phase.last ? `Last counted ${phase.last.confirmations} of ${phase.last.needed} at ${clock(phase.last.checkedAt)}` : 'Not counted yet',
        source: `${label} could not be read since ${clock(phase.since)} · retrying`,
        estimate: null,
      }
    case 'missing':
      return {
        status: `Not seen on ${label} since ${clock(phase.since)}`,
        source: 'No server reports this transaction now. If it was replaced, these coins never arrive.',
        estimate: null,
      }
    case 'abandoned':
      return {
        status: `Not seen on ${label} since ${clock(phase.since)}`,
        source: `Shown as void. It counts for nothing unless the transaction reaches a ${label} block.`,
        estimate: null,
      }
  }
}
