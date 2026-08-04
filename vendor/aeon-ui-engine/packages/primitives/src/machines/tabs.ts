import { assign, setup } from 'xstate'

export interface TabsContext {
  value: string
  disabled: boolean
}

export type TabsEvent =
  | { type: 'SELECT'; value: string }
  | { type: 'SET_VALUE'; value: string }

export const tabsMachine = setup({
  types: {
    context: {} as TabsContext,
    events: {} as TabsEvent,
    input: {} as TabsContext,
  },
  guards: {
    notDisabled: ({ context }) => !context.disabled,
    hasValue: ({ event }) => event.type === 'SELECT' && Boolean(event.value),
  },
  actions: {
    select: assign({
      value: ({ event }) => (event.type === 'SELECT' ? event.value : ''),
    }),
    setValue: assign({
      value: ({ event }) => (event.type === 'SET_VALUE' ? event.value : ''),
    }),
  },
}).createMachine({
  id: 'tabs',
  context: ({ input }) => ({
    value: input.value ?? '',
    disabled: input.disabled ?? false,
  }),
  /** Single stable region: which trigger is active. */
  initial: 'active',
  states: {
    active: {
      on: {
        SELECT: { actions: 'select', guard: 'hasValue' },
        SET_VALUE: { actions: 'setValue' },
      },
    },
  },
})
