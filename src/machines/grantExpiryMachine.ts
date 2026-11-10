import { assign, setup } from 'xstate'

/** A grant with no `expiresAt` never lapses; this is how existing grants stay as they are. */
export const GRANT_EXPIRING_SOON_MS = 24 * 60 * 60 * 1000

/**
 * Chart: grantExpiry — one connected app's grant over time (BRC-73 permission grants).
 * States: active → expiring (inside the warning window) → expired; revoked from any state.
 * `TICK` carries the clock; the chart never reads it, so tests drive time.
 */
export const grantExpiryMachine = setup({
  types: {
    context: {} as { expiresAt: number | null; now: number },
    events: {} as
      | { type: 'TICK'; now: number }
      | { type: 'SET_EXPIRY'; expiresAt: number | null; now: number }
      | { type: 'REVOKE' },
    input: {} as { expiresAt: number | null; now: number },
  },
  guards: {
    lapsed: ({ context }) => context.expiresAt != null && context.now >= context.expiresAt,
    soon: ({ context }) =>
      context.expiresAt != null && context.expiresAt - context.now <= GRANT_EXPIRING_SOON_MS,
  },
}).createMachine({
  id: 'grantExpiry',
  context: ({ input }) => ({ expiresAt: input.expiresAt, now: input.now }),
  initial: 'check',
  on: { REVOKE: '.revoked' },
  states: {
    check: {
      always: [{ guard: 'lapsed', target: 'expired' }, { guard: 'soon', target: 'expiring' }, { target: 'active' }],
    },
    active: {
      on: {
        TICK: { actions: assign({ now: ({ event }) => event.now }), target: 'check', reenter: true },
        SET_EXPIRY: {
          actions: assign({ expiresAt: ({ event }) => event.expiresAt, now: ({ event }) => event.now }),
          target: 'check',
        },
      },
    },
    expiring: {
      on: {
        TICK: { actions: assign({ now: ({ event }) => event.now }), target: 'check' },
        SET_EXPIRY: {
          actions: assign({ expiresAt: ({ event }) => event.expiresAt, now: ({ event }) => event.now }),
          target: 'check',
        },
      },
    },
    expired: {
      // A lapsed grant is gone until the user connects again; it cannot be extended in place.
      type: 'final',
    },
    revoked: { type: 'final' },
  },
})
