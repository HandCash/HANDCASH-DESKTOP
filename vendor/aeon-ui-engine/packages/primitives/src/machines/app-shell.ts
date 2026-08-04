import { assign, setup } from 'xstate'

export const APP_SHELL_STATES = ['idle', 'overlayOpen'] as const
export type AppShellState = (typeof APP_SHELL_STATES)[number]

export interface AppShellContext {
  /** Bottom (or edge) dock chrome — tab bar, action dock. */
  dockVisible: boolean
}

export type AppShellEvent =
  | { type: 'OPEN_OVERLAY' }
  | { type: 'CLOSE_OVERLAY' }
  | { type: 'SHOW_DOCK' }
  | { type: 'HIDE_DOCK' }
  | { type: 'SET_DOCK'; visible: boolean }

/**
 * Application chrome frame — layered top / content / dock / overlays.
 * Reference: HandCash items-market MainLayout (content dims when overlay open).
 *
 * Parallel concerns:
 * - region `chrome`: idle | overlayOpen (content inert + scrim)
 * - context `dockVisible`: whether the edge dock is shown
 */
export const appShellMachine = setup({
  types: {
    context: {} as AppShellContext,
    events: {} as AppShellEvent,
    input: {} as Partial<AppShellContext>,
  },
  actions: {
    showDock: assign({ dockVisible: true }),
    hideDock: assign({ dockVisible: false }),
    setDock: assign({
      dockVisible: ({ event }) => (event.type === 'SET_DOCK' ? event.visible : true),
    }),
  },
}).createMachine({
  id: 'appShell',
  context: ({ input }) => ({
    dockVisible: input?.dockVisible ?? true,
  }),
  initial: 'idle',
  states: {
    idle: {
      on: {
        OPEN_OVERLAY: 'overlayOpen',
        SHOW_DOCK: { actions: 'showDock' },
        HIDE_DOCK: { actions: 'hideDock' },
        SET_DOCK: { actions: 'setDock' },
      },
    },
    overlayOpen: {
      on: {
        CLOSE_OVERLAY: 'idle',
        SHOW_DOCK: { actions: 'showDock' },
        HIDE_DOCK: { actions: 'hideDock' },
        SET_DOCK: { actions: 'setDock' },
      },
    },
  },
})
