import { assign, fromPromise, setup } from 'xstate'

/** What the user's review of one app write returned. */
export type ImportReviewDecision = 'allow' | 'deny' | 'timeout'

/** Why an app write did not land. Each one means nothing was written. */
export type ImportWriteRefusal = 'denied' | 'timeout' | 'revoked' | 'unauthorized' | 'failed'

/**
 * Chart: importWriteGrant — one app write into the wallet (Packet F,
 * docs/migration-write-permissions.md). The decrypted delivery waits in
 * `pendingReview` while the user reviews it through the BRC-100 action queue.
 * An approval is one grant for one write: `authorizing` re-checks the scope
 * (host still connected, same account and network, receiver unrevoked, before
 * the deadline) synchronously, then `committing` runs the write, which checks
 * again right before storage. Denial, timeout, revocation or a stale scope go to
 * `refused` and nothing is written. Context holds metadata only, never keys.
 */
export const importWriteGrantMachine = setup({
  types: {
    context: {} as {
      authorized: () => boolean
      refusal: ImportWriteRefusal | null
      receipt: unknown
    },
    input: {} as { authorized: () => boolean },
    events: {} as { type: 'REVOKE' },
    output: {} as { receipt: unknown; refusal: ImportWriteRefusal | null },
  },
  actors: {
    review: fromPromise<ImportReviewDecision>(async () => {
      throw new Error('importWriteGrant: provide a review actor')
    }),
    persist: fromPromise<unknown>(async () => {
      throw new Error('importWriteGrant: provide a persist actor')
    }),
  },
  guards: {
    authorized: ({ context }) => {
      try {
        return context.authorized()
      } catch {
        return false
      }
    },
  },
}).createMachine({
  id: 'importWriteGrant',
  context: ({ input }) => ({ authorized: input.authorized, refusal: null, receipt: null }),
  output: ({ context }) => ({ receipt: context.receipt, refusal: context.refusal }),
  initial: 'pendingReview',
  states: {
    pendingReview: {
      invoke: {
        src: 'review',
        onDone: [
          { guard: ({ event }) => event.output === 'allow', target: 'authorizing' },
          {
            guard: ({ event }) => event.output === 'timeout',
            target: 'refused',
            actions: assign({ refusal: 'timeout' }),
          },
          { target: 'refused', actions: assign({ refusal: 'denied' }) },
        ],
        onError: { target: 'refused', actions: assign({ refusal: 'denied' }) },
      },
      on: { REVOKE: { target: 'refused', actions: assign({ refusal: 'revoked' }) } },
    },
    authorizing: {
      always: [
        { guard: 'authorized', target: 'committing' },
        { target: 'refused', actions: assign({ refusal: 'unauthorized' }) },
      ],
    },
    /** The write's own synchronous guard refuses a revocation that lands now. */
    committing: {
      invoke: {
        src: 'persist',
        onDone: { target: 'accepted', actions: assign({ receipt: ({ event }) => event.output }) },
        onError: { target: 'refused', actions: assign({ refusal: 'failed' }) },
      },
    },
    accepted: { type: 'final' },
    refused: { type: 'final' },
  },
})
