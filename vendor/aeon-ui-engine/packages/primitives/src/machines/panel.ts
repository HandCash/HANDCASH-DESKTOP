import { assign, setup } from 'xstate'

export interface PanelContext {
  expanded: boolean
}

export type PanelEvent =
  | { type: 'EXPAND' }
  | { type: 'COLLAPSE' }
  | { type: 'TOGGLE' }
  | { type: 'SET_EXPANDED'; expanded: boolean }

/**
 * Panel layout region — expanded | collapsed.
 * Collapsed hides content and exposes a vertical rail label.
 */
export const panelMachine = setup({
  types: {
    context: {} as PanelContext,
    events: {} as PanelEvent,
    input: {} as Partial<PanelContext>,
  },
  actions: {
    markExpanded: assign({ expanded: true }),
    markCollapsed: assign({ expanded: false }),
    toggleExpanded: assign({ expanded: ({ context }) => !context.expanded }),
    setExpanded: assign({
      expanded: ({ event }) => (event.type === 'SET_EXPANDED' ? event.expanded : true),
    }),
  },
}).createMachine({
  id: 'panel',
  context: ({ input }) => ({
    expanded: input.expanded ?? true,
  }),
  initial: 'resolve',
  states: {
    resolve: {
      always: [
        { target: 'collapsed', guard: ({ context }) => !context.expanded },
        { target: 'expanded' },
      ],
    },
    expanded: {
      on: {
        COLLAPSE: { target: 'collapsed', actions: 'markCollapsed' },
        TOGGLE: { target: 'collapsed', actions: 'markCollapsed' },
        SET_EXPANDED: [
          {
            target: 'collapsed',
            actions: 'markCollapsed',
            guard: ({ event }) => !event.expanded,
          },
        ],
      },
    },
    collapsed: {
      on: {
        EXPAND: { target: 'expanded', actions: 'markExpanded' },
        TOGGLE: { target: 'expanded', actions: 'markExpanded' },
        SET_EXPANDED: [
          {
            target: 'expanded',
            actions: 'markExpanded',
            guard: ({ event }) => event.expanded,
          },
        ],
      },
    },
  },
})
