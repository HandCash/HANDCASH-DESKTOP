import { setup } from 'xstate'

export type FileUploadPhase = 'idle' | 'dragging' | 'rejected'

export type FileUploadEvent =
  | { type: 'DRAG_OVER' }
  | { type: 'DRAG_LEAVE' }
  | { type: 'DROP_ACCEPT' }
  | { type: 'DROP_REJECT' }
  | { type: 'RESET' }

/**
 * Drag-and-drop surface lifecycle. Selected file bytes stay in React
 * (or parent callbacks); idle / dragging / rejected are chart-owned.
 */
export const fileUploadMachine = setup({
  types: {} as {
    events: FileUploadEvent
  },
}).createMachine({
  id: 'fileUpload',
  initial: 'idle',
  states: {
    idle: {
      on: {
        DRAG_OVER: 'dragging',
        DROP_REJECT: 'rejected',
        RESET: 'idle',
      },
    },
    dragging: {
      on: {
        DRAG_OVER: 'dragging',
        DRAG_LEAVE: 'idle',
        DROP_ACCEPT: 'idle',
        DROP_REJECT: 'rejected',
      },
    },
    rejected: {
      on: {
        DRAG_OVER: 'dragging',
        DROP_ACCEPT: 'idle',
        DROP_REJECT: 'rejected',
        RESET: 'idle',
      },
    },
  },
})

export function getFileUploadPhase(value: unknown): FileUploadPhase {
  if (value === 'idle' || value === 'dragging' || value === 'rejected') {
    return value
  }
  return 'idle'
}
