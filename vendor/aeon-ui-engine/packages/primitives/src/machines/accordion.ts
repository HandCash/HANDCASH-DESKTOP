import { assign, setup } from 'xstate'

export interface AccordionContext {
  value: string[]
  multiple: boolean
  collapsible: boolean
}

export type AccordionEvent =
  | { type: 'TOGGLE'; item: string }
  | { type: 'SET_VALUE'; value: string[] }

function toggleItem(items: string[], item: string, multiple: boolean, collapsible: boolean) {
  const isOpen = items.includes(item)
  if (!multiple) {
    if (isOpen) return collapsible ? [] : items
    return [item]
  }
  if (isOpen) return items.filter((i) => i !== item)
  return [...items, item]
}

export const accordionMachine = setup({
  types: {
    context: {} as AccordionContext,
    events: {} as AccordionEvent,
    input: {} as AccordionContext,
  },
  actions: {
    toggle: assign({
      value: ({ context, event }) =>
        event.type === 'TOGGLE'
          ? toggleItem(context.value, event.item, context.multiple, context.collapsible)
          : context.value,
    }),
    setValue: assign({
      value: ({ event }) => (event.type === 'SET_VALUE' ? event.value : []),
    }),
  },
}).createMachine({
  id: 'accordion',
  context: ({ input }) => ({
    value: input.value ?? [],
    multiple: input.multiple ?? false,
    collapsible: input.collapsible ?? true,
  }),
  initial: 'managing',
  states: {
    managing: {
      on: {
        TOGGLE: { actions: 'toggle' },
        SET_VALUE: { actions: 'setValue' },
      },
    },
  },
})
