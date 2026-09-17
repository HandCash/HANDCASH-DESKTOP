/**
 * Statechart for a bulk item send — the legal transitions of a multi-transaction
 * run over one selection.
 *
 * The chart owns the questions the loop must not answer for itself: may another
 * leg start, may a rejected leg be halved and retried, and is the run over. The
 * imperative sender signs inside `sending` and reports the outcome; it never
 * decides to keep going after a non-item-local fault.
 *
 * Legs are counted, not held: `queued` is the chart's own view of outstanding
 * work, so a split (one leg becomes two) is a real transition rather than a
 * bookkeeping detail hidden in the executor.
 */
import { assign, setup, type SnapshotFrom } from 'xstate'

export type CollectableSendRunContext = {
  /** Legs planned at START, before any split. */
  planned: number
  /** Legs still to attempt, including halves created by a split. */
  queued: number
  sentLegs: number
  sentItems: number
  failedItems: number
  /** Set when a non-item-local fault ended the run. */
  stopped: 'fault' | null
  error: string | null
}

export type CollectableSendRunEvent =
  | { type: 'START'; legs: number }
  /** One leg signed. */
  | { type: 'LEG_SENT'; items: number }
  /** Leg rejected. `items` decides whether halving is still possible. */
  | { type: 'LEG_REJECTED'; items: number; reason: string }
  /** The run cannot continue — remaining legs would fail the same way. */
  | { type: 'RUN_FAULT'; reason: string; remainingItems: number }
  | { type: 'RESET' }

const emptyContext: CollectableSendRunContext = {
  planned: 0,
  queued: 0,
  sentLegs: 0,
  sentItems: 0,
  failedItems: 0,
  stopped: null,
  error: null,
}

export const collectableSendRunMachine = setup({
  types: {
    context: {} as CollectableSendRunContext,
    events: {} as CollectableSendRunEvent,
  },
  guards: {
    /** A leg of two or more can be halved; a single has nothing left to isolate. */
    legDivisible: ({ event }) =>
      event.type === 'LEG_REJECTED' && event.items > 1,
    hasQueuedLeg: ({ context }) => context.queued > 0,
  },
  actions: {
    begin: assign(({ event }) =>
      event.type === 'START'
        ? { ...emptyContext, planned: event.legs, queued: event.legs }
        : {},
    ),
    recordSent: assign(({ context, event }) =>
      event.type === 'LEG_SENT'
        ? {
            queued: Math.max(0, context.queued - 1),
            sentLegs: context.sentLegs + 1,
            sentItems: context.sentItems + event.items,
          }
        : {},
    ),
    /** One rejected leg leaves the queue and two halves join it. */
    recordSplit: assign(({ context, event }) =>
      event.type === 'LEG_REJECTED'
        ? { queued: context.queued + 1, error: event.reason }
        : {},
    ),
    recordFailed: assign(({ context, event }) =>
      event.type === 'LEG_REJECTED'
        ? {
            queued: Math.max(0, context.queued - 1),
            failedItems: context.failedItems + event.items,
            error: event.reason,
          }
        : {},
    ),
    recordRunFault: assign(({ context, event }) =>
      event.type === 'RUN_FAULT'
        ? {
            failedItems: context.failedItems + event.remainingItems,
            queued: 0,
            stopped: 'fault' as const,
            error: event.reason,
          }
        : {},
    ),
    clear: assign(() => ({ ...emptyContext })),
  },
}).createMachine({
  id: 'collectableSendRun',
  initial: 'idle',
  context: { ...emptyContext },
  states: {
    idle: {
      on: { START: { target: 'sending', actions: 'begin' } },
    },
    sending: {
      on: {
        LEG_SENT: { target: 'checking', actions: 'recordSent' },
        LEG_REJECTED: [
          { guard: 'legDivisible', target: 'splitting', actions: 'recordSplit' },
          { target: 'checking', actions: 'recordFailed' },
        ],
        RUN_FAULT: { target: 'halted', actions: 'recordRunFault' },
      },
    },
    /** The halves are queued; sending resumes with the smaller legs. */
    splitting: {
      always: { target: 'sending' },
    },
    checking: {
      always: [
        { guard: 'hasQueuedLeg', target: 'sending' },
        { target: 'done' },
      ],
    },
    done: {
      on: { RESET: { target: 'idle', actions: 'clear' } },
    },
    halted: {
      on: { RESET: { target: 'idle', actions: 'clear' } },
    },
  },
})

export type CollectableSendRunSnapshot = SnapshotFrom<
  typeof collectableSendRunMachine
>
