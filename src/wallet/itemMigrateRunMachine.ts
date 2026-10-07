/**
 * Statechart for one item-migrate run: tips held by foreign keys moved into
 * this wallet as a sequence of shared transactions.
 *
 * The chart answers what the executor must not decide for itself: may another
 * bundle start, may a rejected bundle be halved, may a busy wallet or a spent
 * fee coin be waited out, and is the run over. The executor builds and signs
 * inside `moving` and reports one classified outcome per bundle.
 *
 * Tips are counted, not held: `queued` is the chart's view of outstanding work.
 */
import { assign, setup, type SnapshotFrom } from 'xstate'
import type { ItemMigrateFaultKind, ItemMigrateStop } from './itemMigrateRun'
import type { ForeignInputPropagation } from './foreignInputAction'

/** Waits for the spend region before a busy wallet stops the run. */
export const ITEM_MIGRATE_BUSY_WAITS = 2
/** Fresh builds over new funding before a spent fee coin stops the run. */
export const ITEM_MIGRATE_FUNDING_REBUILDS = 1

export type ItemMigrateRunContext = {
  /** Tips per transaction when nothing has been rejected. */
  cap: number
  /** Tips the next bundle may carry; halved by a rejection, reset by a send. */
  perTx: number
  queued: number
  moved: number
  failed: number
  busyWaits: number
  fundingRebuilds: number
  stopped: ItemMigrateStop | null
  error: string | null
}

export type ItemMigrateRunEvent =
  | { type: 'START'; items: number; perTx: number }
  /** One bundle signed and handed to the lifecycle. */
  | { type: 'SENT'; items: number; propagation: ForeignInputPropagation }
  | { type: 'FAULT'; fault: ItemMigrateFaultKind; items: number; message: string }
  /** The wait for a busy wallet ended. */
  | { type: 'WAITED' }

const emptyContext: ItemMigrateRunContext = {
  cap: 1,
  perTx: 1,
  queued: 0,
  moved: 0,
  failed: 0,
  busyWaits: 0,
  fundingRebuilds: 0,
  stopped: null,
  error: null,
}

const STOPPING_FAULTS: ReadonlySet<ItemMigrateFaultKind> = new Set(['funds', 'abandoned', 'locked', 'network'])

export const itemMigrateRunMachine = setup({
  types: {
    context: {} as ItemMigrateRunContext,
    events: {} as ItemMigrateRunEvent,
  },
  guards: {
    sentStillPropagating: ({ context, event }) =>
      event.type === 'SENT' && event.propagation === 'propagating' && context.queued > event.items,
    busyWaitLeft: ({ context, event }) =>
      event.type === 'FAULT' && event.fault === 'busy' && context.busyWaits < ITEM_MIGRATE_BUSY_WAITS,
    busy: ({ event }) => event.type === 'FAULT' && event.fault === 'busy',
    fundingRebuildLeft: ({ context, event }) =>
      event.type === 'FAULT' && event.fault === 'stale-funding' && context.fundingRebuilds < ITEM_MIGRATE_FUNDING_REBUILDS,
    staleFunding: ({ event }) => event.type === 'FAULT' && event.fault === 'stale-funding',
    stoppingFault: ({ event }) => event.type === 'FAULT' && STOPPING_FAULTS.has(event.fault),
    /** Named tips are already spent: they leave, the rest of the bundle goes again whole. */
    deadTips: ({ event }) => event.type === 'FAULT' && event.fault === 'dead-tips',
    /** A bundle of two or more can be halved; a single has nothing left to isolate. */
    divisible: ({ event }) => event.type === 'FAULT' && event.fault === 'rejected' && event.items > 1,
    hasQueued: ({ context }) => context.queued > 0,
  },
  actions: {
    begin: assign(({ event }) =>
      event.type === 'START'
        ? { ...emptyContext, cap: Math.max(1, event.perTx), perTx: Math.max(1, event.perTx), queued: event.items }
        : {},
    ),
    recordSent: assign(({ context, event }) =>
      event.type === 'SENT'
        ? {
            queued: Math.max(0, context.queued - event.items),
            moved: context.moved + event.items,
            perTx: context.cap,
            busyWaits: 0,
            fundingRebuilds: 0,
          }
        : {},
    ),
    stopPropagating: assign({ stopped: 'propagating' as ItemMigrateStop }),
    countBusyWait: assign(({ context }) => ({ busyWaits: context.busyWaits + 1 })),
    countFundingRebuild: assign(({ context }) => ({ fundingRebuilds: context.fundingRebuilds + 1 })),
    halve: assign(({ event }) =>
      event.type === 'FAULT' ? { perTx: Math.max(1, Math.ceil(event.items / 2)), error: event.message } : {},
    ),
    recordFailed: assign(({ context, event }) =>
      event.type === 'FAULT'
        ? { queued: Math.max(0, context.queued - 1), failed: context.failed + 1, perTx: context.cap, error: event.message }
        : {},
    ),
    recordDead: assign(({ context, event }) =>
      event.type === 'FAULT'
        ? { queued: Math.max(0, context.queued - event.items), failed: context.failed + event.items, error: event.message }
        : {},
    ),
    recordStop: assign(({ event }) =>
      event.type === 'FAULT' ? { stopped: event.fault as ItemMigrateStop, error: event.message } : {},
    ),
  },
}).createMachine({
  id: 'itemMigrateRun',
  initial: 'idle',
  context: { ...emptyContext },
  states: {
    idle: {
      on: { START: { target: 'checking', actions: 'begin' } },
    },
    moving: {
      on: {
        SENT: [
          { guard: 'sentStillPropagating', target: 'stopped', actions: ['recordSent', 'stopPropagating'] },
          { target: 'checking', actions: 'recordSent' },
        ],
        FAULT: [
          { guard: 'busyWaitLeft', target: 'waitingForWallet', actions: 'countBusyWait' },
          { guard: 'busy', target: 'stopped', actions: 'recordStop' },
          { guard: 'fundingRebuildLeft', target: 'rebuilding', actions: 'countFundingRebuild' },
          { guard: 'staleFunding', target: 'stopped', actions: 'recordStop' },
          { guard: 'stoppingFault', target: 'stopped', actions: 'recordStop' },
          { guard: 'deadTips', target: 'checking', actions: 'recordDead' },
          { guard: 'divisible', target: 'splitting', actions: 'halve' },
          { target: 'checking', actions: 'recordFailed' },
        ],
      },
    },
    /** The spend region never opened; wait for it, then retry the same bundle whole. */
    waitingForWallet: {
      on: { WAITED: { target: 'moving' } },
    },
    /** The dead fee coin is retired; one fresh build usually funds over live change. */
    rebuilding: {
      always: { target: 'moving' },
    },
    /** The bundle's first half goes next; the rest follows in later bundles. */
    splitting: {
      always: { target: 'moving' },
    },
    checking: {
      always: [{ guard: 'hasQueued', target: 'moving' }, { target: 'done' }],
    },
    done: { type: 'final' },
    stopped: { type: 'final' },
  },
})

export type ItemMigrateRunSnapshot = SnapshotFrom<typeof itemMigrateRunMachine>
