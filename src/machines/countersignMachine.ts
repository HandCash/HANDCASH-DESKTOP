import { assign, setup } from 'xstate'
import type { CountersignTransferPath } from '../wallet/countersign/path'

type Context = {
  operation: 'issue' | 'transfer' | null
  path: CountersignTransferPath | null
  requestId: string | null
  txid: string | null
  error: string | null
}

type Event =
  | { type: 'ISSUE' }
  | { type: 'TRANSFER'; path: CountersignTransferPath }
  | { type: 'SIGNED'; requestId: string }
  | { type: 'ACCEPTED'; txid: string }
  | { type: 'REFUSED'; error: string }
  | { type: 'SILENT'; error: string }
  | { type: 'BROADCASTED'; txid: string }
  | { type: 'COMMITTED' }
  | { type: 'FAIL'; error: string }

/**
 * Issue or transfer a countersigned asset. A transfer exists only once an
 * acceptor countersigns it: until ACCEPTED nothing can be broadcast, so a
 * refusal or silence ends with no transaction and the holder's units intact.
 * A silent acceptor leaves the request open — repeating it is the same
 * request, and its inputs stay reserved for it. On a released asset the
 * holder countersigns with the published release keys, so "requesting"
 * ends in ACCEPTED without asking anyone.
 */
export const countersignMachine = setup({
  types: { context: {} as Context, events: {} as Event },
  actions: {
    issue: assign({ operation: 'issue', path: null, requestId: null, txid: null, error: null }),
    transfer: assign(({ event }) =>
      event.type === 'TRANSFER'
        ? {
            operation: 'transfer' as const,
            path: event.path,
            requestId: null,
            txid: null,
            error: event.path.path === 'refuse' ? event.path.reason : null,
          }
        : {},
    ),
    requestId: assign(({ event }) => (event.type === 'SIGNED' ? { requestId: event.requestId } : {})),
    txid: assign(({ event }) =>
      event.type === 'ACCEPTED' || event.type === 'BROADCASTED' ? { txid: event.txid } : {},
    ),
    error: assign(({ event }) =>
      event.type === 'FAIL' || event.type === 'REFUSED' || event.type === 'SILENT' ? { error: event.error } : {},
    ),
  },
  guards: {
    refused: ({ context }) => context.path?.path === 'refuse',
  },
}).createMachine({
  id: 'countersign',
  initial: 'idle',
  context: { operation: null, path: null, requestId: null, txid: null, error: null },
  states: {
    idle: {
      on: {
        ISSUE: { target: 'issuing', actions: 'issue' },
        TRANSFER: { target: 'classifying', actions: 'transfer' },
      },
    },
    issuing: {
      on: {
        BROADCASTED: { target: 'broadcast', actions: 'txid' },
        FAIL: { target: 'failed', actions: 'error' },
      },
    },
    classifying: {
      always: [{ guard: 'refused', target: 'failed' }, { target: 'holderSigning' }],
    },
    holderSigning: {
      on: {
        SIGNED: { target: 'requesting', actions: 'requestId' },
        FAIL: { target: 'failed', actions: 'error' },
      },
    },
    requesting: {
      on: {
        ACCEPTED: { target: 'accepted', actions: 'txid' },
        REFUSED: { target: 'refused', actions: 'error' },
        SILENT: { target: 'outstanding', actions: 'error' },
        FAIL: { target: 'failed', actions: 'error' },
      },
    },
    // Countersigned is final against the sender: a later failure never voids it.
    accepted: {
      on: {
        BROADCASTED: { target: 'broadcast', actions: 'txid' },
        FAIL: { actions: 'error' },
      },
    },
    broadcast: {
      on: {
        COMMITTED: 'committed',
        FAIL: { actions: 'error' },
      },
    },
    outstanding: { type: 'final' },
    refused: { type: 'final' },
    committed: { type: 'final' },
    failed: { type: 'final' },
  },
})
