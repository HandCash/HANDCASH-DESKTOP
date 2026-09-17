import { setup, assign } from 'xstate'

export type AssetSendContext = {
  to: string
  /** Token quantity. Collectable sends leave this empty — count is not sats. */
  quantity: string
  needsQuantity: boolean
  friendLabel: string | null
  payeeIdentityKey: string | null
  /** Domain send chart refusal, when the path is not spendable. */
  refuseReason: string | null
  error: string | null
}

export type AssetSendInput = {
  needsQuantity?: boolean
}

/**
 * Chart: assetSend
 * States: editing → confirming → handoff | failure
 *
 * Compose for collectable and BSV-21 send panels. Review does not require a
 * sat amount. Token panels set `needsQuantity`. Path refuse is classified by
 * collectableSendMachine / bsv21SendMachine, then stored here so Confirm cannot
 * proceed on a chart the domain already failed.
 */
export const assetSendMachine = setup({
  types: {
    context: {} as AssetSendContext,
    input: {} as AssetSendInput,
    events: {} as
      | {
          type: 'EDIT'
          to?: string
          quantity?: string
          friendLabel?: string | null
          payeeIdentityKey?: string | null
        }
      | { type: 'CLASSIFY'; refuseReason: string | null }
      | { type: 'REVIEW' }
      | { type: 'BACK' }
      | { type: 'CONFIRM' }
      | { type: 'FAIL'; error: string }
      | { type: 'RESET' },
  },
  guards: {
    canReview: ({ context }) =>
      !context.refuseReason &&
      context.to.trim().length > 0 &&
      (!context.needsQuantity || Number(context.quantity) > 0),
  },
}).createMachine({
  id: 'assetSend',
  initial: 'editing',
  context: ({ input }) => ({
    to: '',
    quantity: '',
    needsQuantity: Boolean(input?.needsQuantity),
    friendLabel: null,
    payeeIdentityKey: null,
    refuseReason: null,
    error: null,
  }),
  states: {
    editing: {
      on: {
        EDIT: {
          actions: assign({
            to: ({ context, event }) => event.to ?? context.to,
            quantity: ({ context, event }) =>
              event.quantity !== undefined ? event.quantity : context.quantity,
            friendLabel: ({ context, event }) =>
              event.friendLabel !== undefined
                ? event.friendLabel
                : context.friendLabel,
            payeeIdentityKey: ({ context, event }) =>
              event.payeeIdentityKey !== undefined
                ? event.payeeIdentityKey
                : context.payeeIdentityKey,
            error: null,
          }),
        },
        CLASSIFY: {
          actions: assign({
            refuseReason: ({ event }) => event.refuseReason,
            error: ({ event }) => event.refuseReason,
          }),
        },
        REVIEW: {
          guard: 'canReview',
          target: 'confirming',
        },
      },
    },
    confirming: {
      on: {
        BACK: 'editing',
        CLASSIFY: [
          {
            guard: ({ event }) => Boolean(event.refuseReason),
            target: 'failure',
            actions: assign({
              refuseReason: ({ event }) => event.refuseReason,
              error: ({ event }) => event.refuseReason,
            }),
          },
          {
            actions: assign({
              refuseReason: ({ event }) => event.refuseReason,
              error: null,
            }),
          },
        ],
        CONFIRM: 'handoff',
        FAIL: {
          target: 'failure',
          actions: assign({ error: ({ event }) => event.error }),
        },
      },
    },
    handoff: {
      on: {
        RESET: {
          target: 'editing',
          actions: assign(({ context }) => ({
            to: '',
            quantity: '',
            needsQuantity: context.needsQuantity,
            friendLabel: null,
            payeeIdentityKey: null,
            refuseReason: null,
            error: null,
          })),
        },
      },
    },
    failure: {
      on: {
        BACK: 'editing',
        RESET: {
          target: 'editing',
          actions: assign({ error: null, refuseReason: null }),
        },
      },
    },
  },
})
