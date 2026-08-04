import { setup } from 'xstate'

export interface ToastContext {
  durationMs: number
}

export type ToastEvent =
  | { type: 'SHOW' }
  | { type: 'DISMISS' }
  | { type: 'TIMEOUT' }

/** Toast lifecycle: hidden → visible → hidden (dismiss or auto timeout). */
export const toastMachine = setup({
  types: {
    context: {} as ToastContext,
    events: {} as ToastEvent,
    input: {} as ToastContext,
  },
  guards: {
    hasDuration: ({ context }) => context.durationMs > 0,
  },
  delays: {
    VISIBLE_TIMEOUT: ({ context }) => context.durationMs,
  },
}).createMachine({
  id: 'toast',
  context: ({ input }) => ({ durationMs: input.durationMs ?? 5000 }),
  initial: 'hidden',
  states: {
    hidden: {
      on: {
        SHOW: 'visible',
      },
    },
    visible: {
      on: {
        DISMISS: 'hidden',
        TIMEOUT: 'hidden',
      },
      after: {
        VISIBLE_TIMEOUT: {
          target: 'hidden',
          guard: 'hasDuration',
        },
      },
    },
  },
})
