import { assign, setup } from 'xstate'

/**
 * Section + detail stack navigation — the pattern every multi-panel product
 * reinvented (wallet sections, settings drill-in, list→detail).
 *
 * Not product-specific: `section` is a string id; `stack` is opaque child records.
 */
export type AppNavChild = {
  id: string
  /** Free-form type tag (e.g. "detail", "compose", "settings"). */
  type: string
  /** Optional payload for the view layer. */
  data?: unknown
}

export interface AppNavContext {
  section: string
  stack: AppNavChild[]
}

export type AppNavEvent =
  | { type: 'SET_SECTION'; section: string }
  | { type: 'PUSH'; child: AppNavChild }
  | { type: 'REPLACE'; child: AppNavChild }
  | { type: 'POP' }
  | { type: 'POP_TO'; id: string }
  | { type: 'CLEAR' }
  | { type: 'RESET'; section: string }

export function appNavDepth(ctx: AppNavContext): number {
  return ctx.stack.length
}

export function appNavChild(ctx: AppNavContext): AppNavChild | null {
  return ctx.stack.length ? ctx.stack[ctx.stack.length - 1]! : null
}

/** Projected state for data-aeon-state: `section` or `section/childType`. */
export function appNavStateAttr(ctx: AppNavContext): string {
  const child = appNavChild(ctx)
  return child ? `${ctx.section}/${child.type}` : ctx.section
}

export const appNavMachine = setup({
  types: {
    context: {} as AppNavContext,
    events: {} as AppNavEvent,
    input: {} as Partial<AppNavContext> & { section?: string },
  },
  actions: {
    setSection: assign({
      section: ({ event }) => (event.type === 'SET_SECTION' ? event.section : ''),
      stack: [],
    }),
    push: assign({
      stack: ({ context, event }) =>
        event.type === 'PUSH' ? [...context.stack, event.child] : context.stack,
    }),
    replace: assign({
      stack: ({ context, event }) => {
        if (event.type !== 'REPLACE') return context.stack
        if (!context.stack.length) return [event.child]
        return [...context.stack.slice(0, -1), event.child]
      },
    }),
    pop: assign({
      stack: ({ context }) => context.stack.slice(0, -1),
    }),
    popTo: assign({
      stack: ({ context, event }) => {
        if (event.type !== 'POP_TO') return context.stack
        const idx = context.stack.findIndex((c) => c.id === event.id)
        if (idx < 0) return context.stack
        return context.stack.slice(0, idx + 1)
      },
    }),
    clear: assign({ stack: [] }),
    reset: assign({
      section: ({ event }) => (event.type === 'RESET' ? event.section : ''),
      stack: [],
    }),
  },
  guards: {
    canPop: ({ context }) => context.stack.length > 0,
  },
}).createMachine({
  id: 'appNav',
  context: ({ input }) => ({
    section: input?.section ?? 'home',
    stack: input?.stack ?? [],
  }),
  initial: 'ready',
  states: {
    ready: {
      on: {
        SET_SECTION: { actions: 'setSection' },
        PUSH: { actions: 'push' },
        REPLACE: { actions: 'replace' },
        POP: { guard: 'canPop', actions: 'pop' },
        POP_TO: { actions: 'popTo' },
        CLEAR: { actions: 'clear' },
        RESET: { actions: 'reset' },
      },
    },
  },
})
