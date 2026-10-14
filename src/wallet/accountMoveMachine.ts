/**
 * Moving an account another install holds onto this one (draft BRC-249,
 * "Moving on demand"). No step asks the user.
 *
 *   reading ── released / ours ─────────────────────────────▶ taking ─▶ taken
 *      │ held by another install          │ unannounced but in use
 *      ▼                                  ▼
 *   dialing ─ link open ─▶ requestingDirect ─ unacked ─▶ requestingBox
 *      └──── no link ────────────────────────────────────────▲
 *   requesting* ─▶ awaitingAccept ── accept ─▶ awaitingRelease ── released ─▶ taking
 *                      │ answer window                │ release window
 *                      ▼                              ▼
 *                   forcing ─────────────────────────────────────────────▶ taken
 *
 * The request goes device to device over the vault link (`vaultLink.ts`)
 * whenever one opens; the box carries it only when no link does.
 *
 * Every failure is a named `failed` reason; nothing falls through to a take
 * the chart did not choose. `accountMove.ts` provides the actors.
 */
import { assign, fromCallback, fromPromise, setup } from 'xstate'
import { ANSWER_WINDOW_MS, RELEASE_WINDOW_MS } from './accountRelease'
import type { TakeResult } from './vaultAccountHolding'

/** The holder record as this move needs it. */
export type RecordView =
  | { kind: 'released'; seq: number }
  | { kind: 'ours'; seq: number }
  | { kind: 'held'; seq: number; deviceId: string }
  | { kind: 'absent' }
  | { kind: 'unreachable'; reason: string }
  | { kind: 'unsupported' }

export type MoveFailure =
  | 'host-unreachable'
  | 'host-unsupported'
  | 'channel-unreachable'
  | 'take-unavailable'
  | 'kept-changing'

type MoveEvent =
  | { type: 'ACCEPTED' }
  | { type: 'RECORD'; view: RecordView }

/** Times a move starts over when another install wins the record first. */
const MAX_RESTARTS = 2

function movable(view: RecordView): boolean {
  return view.kind === 'released' || view.kind === 'ours'
}

export const accountMoveMachine = setup({
  types: {
    context: {} as {
      seq: number
      /** The holding install, when the record names one: the link's far end. */
      device: string | null
      nonce: string | null
      forced: boolean
      restarts: number
      failure: MoveFailure | null
      detail: string | null
    },
    events: {} as MoveEvent,
    output: {} as
      | { kind: 'moved'; forced: boolean }
      | { kind: 'failed'; failure: MoveFailure; detail: string | null },
  },
  actors: {
    readRecord: fromPromise<RecordView>(async () => {
      throw new Error('readRecord not provided')
    }),
    /** True once a link to `device` is open. */
    dialLink: fromPromise<boolean, { device: string }>(async () => false),
    /** Rejects when the holding install did not ack the frame. */
    sendDirect: fromPromise<{ nonce: string }, { seq: number; device: string }>(async () => {
      throw new Error('sendDirect not provided')
    }),
    sendBox: fromPromise<{ nonce: string }, { seq: number }>(async () => {
      throw new Error('sendBox not provided')
    }),
    take: fromPromise<TakeResult, { force: boolean }>(async () => {
      throw new Error('take not provided')
    }),
    /** Sends ACCEPTED once an accept carrying `nonce` arrives. */
    watchAccept: fromCallback<MoveEvent, { nonce: string }>(() => () => {}),
    /** Sends RECORD with each read of the holder record. */
    watchRecord: fromCallback<MoveEvent>(() => () => {}),
  },
  delays: {
    answerWindow: ANSWER_WINDOW_MS,
    releaseWindow: RELEASE_WINDOW_MS,
  },
  guards: {
    recordMovable: ({ event }) => event.type === 'RECORD' && movable(event.view),
    /** Another install took the record after the one this move asked: start over, a bounded number of times. */
    overtakenRestart: ({ context, event }) =>
      event.type === 'RECORD' && event.view.kind === 'held' && event.view.seq > context.seq &&
      context.restarts < MAX_RESTARTS,
    recordOvertaken: ({ context, event }) =>
      event.type === 'RECORD' && event.view.kind === 'held' && event.view.seq > context.seq,
  },
  actions: {
    restart: assign({ restarts: ({ context }) => context.restarts + 1, nonce: null }),
    keptChanging: assign({ failure: 'kept-changing' as const, detail: null }),
  },
}).createMachine({
  id: 'accountMove',
  initial: 'reading',
  context: { seq: 0, device: null, nonce: null, forced: false, restarts: 0, failure: null, detail: null },
  output: ({ context }) =>
    context.failure
      ? { kind: 'failed', failure: context.failure, detail: context.detail }
      : { kind: 'moved', forced: context.forced },
  states: {
    reading: {
      invoke: {
        src: 'readRecord',
        onDone: [
          { guard: ({ event }) => movable(event.output), target: 'taking' },
          {
            guard: ({ event }) => event.output.kind === 'held',
            target: 'dialing',
            actions: assign({
              seq: ({ event }) => (event.output.kind === 'held' ? event.output.seq : 0),
              device: ({ event }) => (event.output.kind === 'held' ? event.output.deviceId : null),
            }),
          },
          {
            guard: ({ event }) => event.output.kind === 'absent',
            target: 'requestingBox',
            actions: assign({ seq: 0, device: null }),
          },
          {
            guard: ({ event }) => event.output.kind === 'unsupported',
            target: 'failed',
            actions: assign({ failure: 'host-unsupported' as const, detail: null }),
          },
          {
            target: 'failed',
            actions: assign({
              failure: 'host-unreachable' as const,
              detail: ({ event }) => (event.output.kind === 'unreachable' ? event.output.reason : null),
            }),
          },
        ],
        onError: {
          target: 'failed',
          actions: assign({ failure: 'host-unreachable' as const, detail: ({ event }) => String(event.error) }),
        },
      },
    },
    dialing: {
      invoke: {
        src: 'dialLink',
        input: ({ context }) => ({ device: context.device ?? '' }),
        onDone: [{ guard: ({ event }) => event.output, target: 'requestingDirect' }, { target: 'requestingBox' }],
        onError: { target: 'requestingBox' },
      },
    },
    requestingDirect: {
      invoke: {
        src: 'sendDirect',
        input: ({ context }) => ({ seq: context.seq, device: context.device ?? '' }),
        onDone: { target: 'awaitingAccept', actions: assign({ nonce: ({ event }) => event.output.nonce }) },
        onError: { target: 'requestingBox' },
      },
    },
    requestingBox: {
      invoke: {
        src: 'sendBox',
        input: ({ context }) => ({ seq: context.seq }),
        onDone: { target: 'awaitingAccept', actions: assign({ nonce: ({ event }) => event.output.nonce }) },
        // A holder that cannot hear the request may be live: never force without asking.
        onError: {
          target: 'failed',
          actions: assign({ failure: 'channel-unreachable' as const, detail: ({ event }) => String(event.error) }),
        },
      },
    },
    awaitingAccept: {
      invoke: [
        { src: 'watchAccept', input: ({ context }) => ({ nonce: context.nonce ?? '' }) },
        { src: 'watchRecord' },
      ],
      on: {
        ACCEPTED: 'awaitingRelease',
        RECORD: [
          { guard: 'recordMovable', target: 'taking' },
          { guard: 'overtakenRestart', target: 'reading', actions: 'restart' },
          { guard: 'recordOvertaken', target: 'failed', actions: 'keptChanging' },
        ],
      },
      after: { answerWindow: { target: 'forcing' } },
    },
    awaitingRelease: {
      invoke: { src: 'watchRecord' },
      on: {
        RECORD: [
          { guard: 'recordMovable', target: 'taking' },
          { guard: 'overtakenRestart', target: 'reading', actions: 'restart' },
          { guard: 'recordOvertaken', target: 'failed', actions: 'keptChanging' },
        ],
      },
      after: { releaseWindow: { target: 'forcing' } },
    },
    forcing: {
      invoke: {
        src: 'take',
        input: { force: true },
        onDone: [
          { guard: ({ event }) => event.output.kind === 'taken', target: 'taken', actions: assign({ forced: true }) },
          {
            target: 'failed',
            actions: assign({
              failure: 'take-unavailable' as const,
              detail: ({ event }) => (event.output.kind === 'unavailable' ? event.output.reason : null),
            }),
          },
        ],
        onError: {
          target: 'failed',
          actions: assign({ failure: 'take-unavailable' as const, detail: ({ event }) => String(event.error) }),
        },
      },
    },
    taking: {
      invoke: {
        src: 'take',
        input: { force: false },
        onDone: [
          { guard: ({ event }) => event.output.kind === 'taken', target: 'taken' },
          {
            guard: ({ context, event }) => event.output.kind === 'held-elsewhere' && context.restarts < MAX_RESTARTS,
            target: 'reading',
            actions: 'restart',
          },
          {
            guard: ({ event }) => event.output.kind === 'held-elsewhere',
            target: 'failed',
            actions: 'keptChanging',
          },
          {
            target: 'failed',
            actions: assign({
              failure: 'take-unavailable' as const,
              detail: ({ event }) => (event.output.kind === 'unavailable' ? event.output.reason : null),
            }),
          },
        ],
        onError: {
          target: 'failed',
          actions: assign({ failure: 'take-unavailable' as const, detail: ({ event }) => String(event.error) }),
        },
      },
    },
    taken: { type: 'final' },
    failed: { type: 'final' },
  },
})

export type AccountMovePhase =
  | 'reading'
  | 'dialing'
  | 'requestingDirect'
  | 'requestingBox'
  | 'awaitingAccept'
  | 'awaitingRelease'
  | 'forcing'
  | 'taking'
