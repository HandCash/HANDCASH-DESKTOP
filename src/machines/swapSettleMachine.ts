import { setup } from 'xstate'
import type { SettleOutcome } from '../wallet/swap/settle'

/**
 * One wallet-to-wallet swap, as this wallet carries it (`settleRunner.ts`).
 * The runner asks `nextSettleStep` what the facts call for and sends it
 * here; it runs the step only when this chart takes the event. So a lock is
 * made at most once (FUND leaves `negotiating` / `presigning` for good), and
 * nothing is claimed or refunded before this wallet has locked. The state is
 * kept on the swap's record and restored each pass.
 *
 * `settled`: both sides claimed. `refunded`: each payer took its lock back.
 * `ended`: declined or expired before this wallet locked anything. `missed`:
 * the maker's wallet was away past the taker's lock time.
 */

export type SwapSettlePhase = 'negotiating' | 'presigning' | 'locking' | 'locked' | 'claiming' | 'refunding' | 'settled' | 'refunded' | 'ended' | 'missed'

export type SwapSettleEvent =
  | { type: 'PRESIGN' }
  | { type: 'FUND' }
  | { type: 'CLAIM' }
  | { type: 'REFUND' }
  | { type: 'REFUND_FEE' }
  | { type: 'DONE'; outcome: SettleOutcome }
  | { type: 'OK' }
  | { type: 'FAIL'; error: string }

const outcome =
  (...allowed: SettleOutcome[]) =>
  ({ event }: { event: SwapSettleEvent }) =>
    event.type === 'DONE' && allowed.includes(event.outcome)

export const swapSettleMachine = setup({
  types: { events: {} as SwapSettleEvent },
  guards: {
    swapped: outcome('swapped'),
    refundedBack: outcome('refunded'),
    missed: outcome('missed'),
    nothingLocked: outcome('declined', 'expired'),
  },
}).createMachine({
  id: 'swapSettle',
  initial: 'negotiating',
  states: {
    negotiating: {
      on: {
        PRESIGN: 'presigning',
        FUND: 'locking',
        DONE: { guard: 'nothingLocked', target: 'ended' },
      },
    },
    presigning: {
      on: {
        PRESIGN: 'presigning',
        FUND: 'locking',
        DONE: { guard: 'nothingLocked', target: 'ended' },
      },
    },
    locking: { on: { OK: 'locked', FAIL: 'locking', FUND: 'locking' } },
    locked: {
      on: {
        CLAIM: 'claiming',
        REFUND: 'refunding',
        REFUND_FEE: 'refunding',
        DONE: [
          { guard: 'swapped', target: 'settled' },
          { guard: 'refundedBack', target: 'refunded' },
          { guard: 'missed', target: 'missed' },
        ],
      },
    },
    claiming: { on: { OK: 'locked', FAIL: 'locked' } },
    refunding: { on: { OK: 'locked', FAIL: 'locked' } },
    settled: { type: 'final' },
    refunded: { type: 'final' },
    ended: { type: 'final' },
    missed: { type: 'final' },
  },
})
