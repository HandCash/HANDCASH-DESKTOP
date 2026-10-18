import { LTC_BURIAL_DEPTH } from './verify'

/**
 * Where a wLTC deposit stands, and who says so. Confirmations are only ever
 * counted on this wallet's own Litecoin header chain (`headers.ts`); an
 * explorer may say a deposit waits for a block or which block holds it, never
 * how deep it is. Every phase carries the time it was last established, so a
 * stale answer is shown as stale rather than as the present.
 *
 * - `unconfirmed`: an explorer reports the transaction, not yet in a block.
 * - `confirming`: in block `height`; `confirmations` counted on this chain
 *   (0 while this chain has not reached that block).
 * - `movable`: buried {@link LTC_BURIAL_DEPTH} deep on this chain; proof recorded.
 * - `unchecked`: Litecoin could not be read since `since`; `last` is the last
 *   count this chain established, if any.
 * - `missing`: no explorer knows the transaction since `since`.
 * - `abandoned`: missing for long enough to say so. Presentation only: its
 *   wLTC already cannot move, and nothing proves it never will.
 */
export type LtcDepositPhase =
  | { kind: 'unconfirmed'; checkedAt: number }
  | { kind: 'confirming'; confirmations: number; needed: number; height: number; checkedAt: number }
  | { kind: 'movable'; height?: number; checkedAt?: number }
  | { kind: 'unchecked'; since: number; last?: { confirmations: number; needed: number; height: number; checkedAt: number } }
  | { kind: 'missing'; since: number }
  | { kind: 'abandoned'; since: number }

export type LtcDepositView = {
  txid: string
  vout: number
  litoshi: string
  /** The BSV transaction that minted its wLTC. */
  bsvTxid?: string
  /** The wLTC asset it minted. */
  assetId?: string
  at: number
  phase: LtcDepositPhase
}

/** Litecoin's target block interval. Only ever used for a labelled estimate. */
export const LTC_BLOCK_MINUTES = 2.5

export function ltcDepositWaiting(phase: LtcDepositPhase): boolean {
  return phase.kind !== 'movable'
}

/** Confirmations this wallet's own chain has counted, and how many are needed. */
export function ltcDepositCount(phase: LtcDepositPhase): { counted: number; needed: number } {
  switch (phase.kind) {
    case 'confirming':
      return { counted: Math.min(phase.confirmations, phase.needed), needed: phase.needed }
    case 'movable':
      return { counted: LTC_BURIAL_DEPTH, needed: LTC_BURIAL_DEPTH }
    case 'unchecked':
      return phase.last ? { counted: Math.min(phase.last.confirmations, phase.last.needed), needed: phase.last.needed } : { counted: 0, needed: LTC_BURIAL_DEPTH }
    default:
      return { counted: 0, needed: LTC_BURIAL_DEPTH }
  }
}

const clock = (at: number) => {
  const when = new Date(at)
  const time = when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return when.toDateString() === new Date().toDateString()
    ? time
    : `${when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`
}

const minutes = (blocks: number) => {
  const m = Math.max(1, Math.round(blocks * LTC_BLOCK_MINUTES))
  return m >= 60 ? `${Math.round(m / 6) / 10} h` : `${m} min`
}

export type LtcDepositCopy = {
  /** What the deposit's state is, in a few words. */
  status: string
  /** Who established it and when. */
  source: string
  /** A labelled time estimate, only while blocks are what it waits for. */
  estimate: string | null
}

export function describeLtcDeposit(phase: LtcDepositPhase): LtcDepositCopy {
  switch (phase.kind) {
    case 'unconfirmed':
      return {
        status: 'Waiting for its first Litecoin block',
        source: `An explorer reports it unconfirmed · ${clock(phase.checkedAt)}`,
        estimate: `About ${minutes(LTC_BURIAL_DEPTH)} after its first block, if blocks keep Litecoin's 2.5-minute pace`,
      }
    case 'confirming': {
      const remaining = phase.needed - Math.min(phase.confirmations, phase.needed)
      return phase.confirmations > 0
        ? {
            status: `${phase.confirmations} of ${phase.needed} Litecoin confirmations`,
            source: `Counted on this wallet's own Litecoin header chain · ${clock(phase.checkedAt)}`,
            estimate: `About ${minutes(remaining)} more, if blocks keep Litecoin's 2.5-minute pace`,
          }
        : {
            status: `In Litecoin block ${phase.height.toLocaleString()}`,
            source: `This wallet's header chain has not reached that block yet · ${clock(phase.checkedAt)}`,
            estimate: `About ${minutes(remaining)}, if blocks keep Litecoin's 2.5-minute pace`,
          }
    }
    case 'movable':
      return {
        status: 'Can move',
        source: `${LTC_BURIAL_DEPTH} or more confirmations on this wallet's own Litecoin header chain`,
        estimate: null,
      }
    case 'unchecked':
      return {
        status: phase.last ? `Last counted ${phase.last.confirmations} of ${phase.last.needed} at ${clock(phase.last.checkedAt)}` : 'Not counted yet',
        source: `Litecoin could not be read since ${clock(phase.since)} · retrying`,
        estimate: null,
      }
    case 'missing':
      return {
        status: `Not seen on Litecoin since ${clock(phase.since)}`,
        source: 'No explorer reports this deposit now. If it was replaced, this wLTC never moves.',
        estimate: null,
      }
    case 'abandoned':
      return {
        status: `Not seen on Litecoin since ${clock(phase.since)}`,
        source: 'Shown as void. This wLTC cannot move unless the deposit reaches a Litecoin block.',
        estimate: null,
      }
  }
}
