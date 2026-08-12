import { setup, assign } from 'xstate'

export type SendContext = {
  to: string
  amount: string
  friendLabel: string | null
  /** When set, confirm uses BRC-29 to this identity key (not plain address P2PKH). */
  payeeIdentityKey: string | null
  error: string | null
  txid: string | null
}

/**
 * Chart: sendPayment
 * States: editing → confirming → broadcasting → success | failure
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
      | { type: 'SUCCESS'; txid: string }
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
    txid: null,
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
        CONFIRM: 'broadcasting',
      },
    },
    broadcasting: {
      on: {
        SUCCESS: {
          target: 'success',
          actions: assign({
            txid: ({ event }) => event.txid,
            error: null,
          }),
        },
        FAIL: {
          target: 'failure',
          actions: assign({ error: ({ event }) => event.error }),
        },
      },
    },
    success: {
      on: {
        RESET: {
          target: 'editing',
          actions: assign({
            to: '',
            amount: '',
            friendLabel: null,
            payeeIdentityKey: null,
            txid: null,
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
