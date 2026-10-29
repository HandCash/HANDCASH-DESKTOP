import { assign, setup } from 'xstate'

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
      | { type: 'CANCEL' }
      | { type: 'CHOOSE_LIFETIME'; value: 'once' | 'session' | 'remember' },
  },
}).createMachine({
  id: 'permissionDecision',
  context: { lifetime: 'session' as 'once' | 'session' | 'remember' },
  initial: 'pending',
  states: {
    pending: {
      on: {
        RESET: { actions: assign({ lifetime: () => 'session' as const }) },
        CHOOSE_LIFETIME: { actions: assign({ lifetime: ({ event }) => event.value }) },
        APPROVE: 'committing',
        CANCEL: 'committing',
      },
    },
    /** The decision was handed to the wallet; further taps are ignored. */
    committing: {
      on: {
        RESET: { target: 'pending', actions: assign({ lifetime: () => 'session' as const }) },
      },
    },
  },
})
