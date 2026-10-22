import { assign, setup } from 'xstate'

export type CallCorner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'

/** The corner nearest a point in a viewport of the given size. */
export function nearestCorner(x: number, y: number, width: number, height: number): CallCorner {
  return `${y < height / 2 ? 'top' : 'bottom'}-${x < width / 2 ? 'left' : 'right'}`
}

/**
 * Chart: callView — how a call sits over the wallet.
 * States: stage (the call bar, video above it) → pip (a small tile in a corner,
 * the wallet usable around it) → popped (the video in the system's
 * picture-in-picture window, over other apps too).
 * Moving around the wallet shrinks a call to pip by itself; the tile expands
 * back on a click and snaps to the corner it is dragged nearest.
 */
export const callViewMachine = setup({
  types: {
    context: {} as { corner: CallCorner },
    events: {} as
      | { type: 'SHRINK' }
      | { type: 'NAVIGATED' }
      | { type: 'EXPAND' }
      | { type: 'MOVE'; corner: CallCorner }
      | { type: 'ENTERED_SYSTEM_PIP' }
      | { type: 'LEFT_SYSTEM_PIP' }
      | { type: 'RESET' },
  },
}).createMachine({
  id: 'callView',
  initial: 'stage',
  context: { corner: 'bottom-right' },
  on: {
    RESET: '.stage',
    MOVE: { actions: assign({ corner: ({ event }) => event.corner }) },
  },
  states: {
    stage: {
      on: {
        SHRINK: 'pip',
        NAVIGATED: 'pip',
        ENTERED_SYSTEM_PIP: 'popped',
      },
    },
    pip: {
      on: {
        EXPAND: 'stage',
        ENTERED_SYSTEM_PIP: 'popped',
      },
    },
    popped: {
      on: {
        LEFT_SYSTEM_PIP: 'stage',
      },
    },
  },
})
