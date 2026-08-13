import { setup, assign } from 'xstate'

export type SendContext = {
  to: string
  amount: string
  friendLabel: string | null
  /** When set, confirm uses BRC-29 to this identity key (not plain address P2PKH). */
  payeeIdentityKey: string | null
  error: string | null
}

/**
 * Chart: sendPayment
 * States: editing → confirming → handoff | failure
 *
 * The panel owns composing and confirming a payment — not watching it land.
 * `CONFIRM` hands the payment to the wallet and closes the panel, so progress
 * and the final result are read from the global payment progress store and
 * Activity instead of being mirrored here. `failure` is reached only by a
 * pre-flight refusal, which the user can still edit their way out of.
 */
export const sendMachine = setup({
  types: {
    context: {} as SendContext,
    events: {} as
      | {
          type: 'EDIT'
          to?: string
          amount?: string
          friendLabel?: string | null
          payeeIdentityKey?: string | null
        }
      | { type: 'REVIEW' }
      | { type: 'BACK' }
      | { type: 'CONFIRM' }
      | { type: 'FAIL'; error: string }
      | { type: 'RESET' },
  },
}).createMachine({
  id: 'sendPayment',
  initial: 'editing',
  context: {
    to: '',
    amount: '',
    friendLabel: null,
    payeeIdentityKey: null,
    error: null,
  },
  states: {
    editing: {
      on: {
        EDIT: {
          actions: assign({
            to: ({ context, event }) => event.to ?? context.to,
            amount: ({ context, event }) => event.amount ?? context.amount,
            friendLabel: ({ context, event }) =>
              event.friendLabel !== undefined ? event.friendLabel : context.friendLabel,
            payeeIdentityKey: ({ context, event }) =>
              event.payeeIdentityKey !== undefined
                ? event.payeeIdentityKey
                : context.payeeIdentityKey,
            error: null,
          }),
        },
        REVIEW: {
          guard: ({ context }) =>
            context.to.trim().length > 0 && Number(context.amount) > 0,
          target: 'confirming',
        },
      },
    },
    confirming: {
      on: {
        BACK: 'editing',
        CONFIRM: 'handoff',
        FAIL: {
          target: 'failure',
          actions: assign({ error: ({ event }) => event.error }),
        },
      },
    },
    /** Handed to the wallet. The panel closes; the send outlives this chart. */
    handoff: {
      on: {
        RESET: {
          target: 'editing',
          actions: assign({
            to: '',
            amount: '',
            friendLabel: null,
            payeeIdentityKey: null,
            error: null,
          }),
        },
      },
    },
    failure: {
      on: {
        BACK: 'editing',
        RESET: { target: 'editing', actions: assign({ error: null }) },
      },
    },
  },
})
