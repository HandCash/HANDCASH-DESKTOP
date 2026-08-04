import { assign, setup } from 'xstate'

export interface ToggleContext {
  checked: boolean
  disabled: boolean
}

export type ToggleEvent =
  | { type: 'TOGGLE' }
  | { type: 'SET_CHECKED'; checked: boolean }
  | { type: 'POINTER_DOWN' }
  | { type: 'POINTER_UP' }
  | { type: 'POINTER_LEAVE' }

/** Checked and unchecked are distinct, stable states. */
export const toggleMachine = setup({
  types: {
    context: {} as ToggleContext,
    events: {} as ToggleEvent,
    input: {} as ToggleContext,
  },
  guards: {
    notDisabled: ({ context }) => !context.disabled,
  },
  actions: {
    flip: assign({
      checked: ({ context }) => !context.checked,
    }),
    setChecked: assign({
      checked: ({ event }) => (event.type === 'SET_CHECKED' ? event.checked : false),
    }),
  },
}).createMachine({
  id: 'toggle',
  context: ({ input }) => ({
    checked: input.checked ?? false,
    disabled: input.disabled ?? false,
  }),
  initial: 'interaction',
  states: {
    interaction: {
      initial: 'idle',
      states: {
        idle: {
          on: {
            POINTER_DOWN: { target: 'pressed', guard: 'notDisabled' },
            TOGGLE: { actions: 'flip', guard: 'notDisabled' },
            SET_CHECKED: { actions: 'setChecked' },
          },
        },
        pressed: {
          on: {
            /* Flip on TOGGLE (click/keyboard) only — pointer up is visual press state. */
            POINTER_UP: 'idle',
            POINTER_LEAVE: 'idle',
          },
        },
      },
    },
  },
})
