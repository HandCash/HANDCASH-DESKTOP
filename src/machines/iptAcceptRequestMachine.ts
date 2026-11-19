import { assign, fromPromise, setup } from 'xstate'
import type { IptRecipient } from '../wallet/bnt/iptRecipients'
import type { IptReservationResult } from '../wallet/bnt/iptReservations'

/** The untrusted request an authenticated sender asks the acceptor to countersign. */
export type IptAcceptRequest = {
  /** BRC-78 authenticated sender identity key. */
  sender: string
  /** The holder-signed proposal, as EF bytes. */
  ef: number[]
  /** BRC-69/72 linkage, one per output. */
  recipients: IptRecipient[]
}

type Outcome = IptReservationResult
type Failure = { message: string; held: boolean }

function failure(error: unknown): Failure {
  const held = (error as { held?: unknown } | null)?.held === true
  return { message: error instanceof Error ? error.message : String(error), held }
}

/**
 * Chart: iptAcceptRequest — one countersign request at the acceptor (BRC-253 §§5–6).
 *
 * idle → accepting → signed | held | refused.
 * `refused` holds nothing: the request failed before any reservation write.
 * `held` means its inputs may be reserved (a pending journal entry or a write
 * attempt). Accept-once forbids a timeout, cancel or new signature from here,
 * and there is no paid recovery: only REPLAY of this same request may finish
 * it, by finding its journaled signature. A still-pending replay stays held.
 * `signed` is final and carries the journaled bytes; the host delivers them
 * and never aborts a signed spend.
 *
 * `accept` is the host actor (`createIptAcceptor`); the default refuses so
 * this chart cannot sign anything until a host is wired in.
 */
export const iptAcceptRequestMachine = setup({
  types: {
    context: {} as {
      request: IptAcceptRequest | null
      requestId: string | null
      signedEf: number[] | null
      error: Failure | null
    },
    events: {} as
      | { type: 'SUBMIT'; request: IptAcceptRequest }
      | { type: 'CANCEL' }
      | { type: 'REPLAY' },
  },
  actors: {
    accept: fromPromise<Outcome, IptAcceptRequest>(async () => {
      throw new Error('No IPT acceptor is wired in')
    }),
  },
  guards: {
    isSigned: ({ event }) => (event as unknown as { output: Outcome }).output.state === 'signed',
    isHeld: ({ event }) => failure((event as { error?: unknown }).error).held,
  },
  actions: {
    recordOutcome: assign(({ event }) => {
      const output = (event as unknown as { output: Outcome }).output
      return {
        requestId: output.requestId,
        signedEf: output.state === 'signed' ? [...output.signedEf] : null,
        error: null,
      }
    }),
    recordFailure: assign({ error: ({ event }) => failure((event as { error?: unknown }).error) }),
    // A failed replay cannot release inputs, whatever the error says.
    recordHeldFailure: assign({
      error: ({ event }) => ({ ...failure((event as { error?: unknown }).error), held: true }),
    }),
  },
}).createMachine({
  id: 'iptAcceptRequest',
  context: { request: null, requestId: null, signedEf: null, error: null },
  initial: 'idle',
  states: {
    idle: {
      on: {
        SUBMIT: {
          target: 'accepting',
          // Snapshot: the sender's object must not change what was validated.
          actions: assign({ request: ({ event }) => structuredClone(event.request) }),
        },
        CANCEL: 'cancelled',
      },
    },
    accepting: {
      invoke: {
        src: 'accept',
        input: ({ context }) => context.request!,
        onDone: [
          { guard: 'isSigned', target: 'signed', actions: 'recordOutcome' },
          // pending: reserved earlier, unsigned; it stays held, never re-signed.
          { target: 'held', actions: 'recordOutcome' },
        ],
        onError: [
          { guard: 'isHeld', target: 'held', actions: 'recordFailure' },
          { target: 'refused', actions: 'recordFailure' },
        ],
      },
    },
    held: {
      on: { REPLAY: 'replaying' },
    },
    replaying: {
      invoke: {
        src: 'accept',
        input: ({ context }) => context.request!,
        onDone: [
          { guard: 'isSigned', target: 'signed', actions: 'recordOutcome' },
          { target: 'held', actions: 'recordOutcome' },
        ],
        onError: { target: 'held', actions: 'recordHeldFailure' },
      },
    },
    signed: { type: 'final' },
    refused: { type: 'final' },
    cancelled: { type: 'final' },
  },
})
