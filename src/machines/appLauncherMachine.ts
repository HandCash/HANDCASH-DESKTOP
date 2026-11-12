import { assign, setup } from 'xstate'

/**
 * Chart: appLauncher — the Apps grid. idle → focused (the tapped tile grows
 * two cells wide and shows its label); tapping the focused tile launches it
 * and returns to idle, tapping another moves focus, DISMISS returns to idle.
 */
export const appLauncherMachine = setup({
  types: {
    context: {} as { focused: string | null },
    events: {} as { type: 'TAP'; id: string } | { type: 'DISMISS' },
  },
  actions: {
    launch: (_, _params: { id: string }) => {},
  },
  guards: {
    isFocused: ({ context, event }) => event.type === 'TAP' && context.focused === event.id,
  },
}).createMachine({
  id: 'appLauncher',
  initial: 'idle',
  context: { focused: null },
  states: {
    idle: {
      entry: assign({ focused: null }),
      on: { TAP: { target: 'focused', actions: assign({ focused: ({ event }) => event.id }) } },
    },
    focused: {
      on: {
        TAP: [
          {
            guard: 'isFocused',
            target: 'idle',
            actions: { type: 'launch', params: ({ event }) => ({ id: event.id }) },
          },
          { actions: assign({ focused: ({ event }) => event.id }) },
        ],
        DISMISS: 'idle',
      },
    },
  },
})
