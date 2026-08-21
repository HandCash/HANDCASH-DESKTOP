import { setup } from 'xstate'

/**
 * One permission prompt accepts exactly one decision.
 *
 * `resolvePermission` is synchronous, but React does not remove the prompt
 * until the next render. Without this edge, two taps in the same frame can run
 * the approval callback twice (sounds, toasts, and app-side retries) even though
 * the permission queue itself resolves only once.
 */
export const permissionDecisionMachine = setup({
  types: {
    events: {} as
      | { type: 'RESET' }
      | { type: 'APPROVE' }
      | { type: 'CANCEL' },
  },
}).createMachine({
  id: 'permissionDecision',
  initial: 'pending',
  states: {
    pending: {
      on: {
        APPROVE: 'committing',
        CANCEL: 'committing',
      },
    },
    /** The decision was handed to the wallet; further taps are ignored. */
    committing: {
      on: {
        RESET: 'pending',
      },
    },
  },
})
