import { setup } from 'xstate'

export const BUTTON_LIFECYCLE_STATES = [
  'idle',
  'pending',
  'success',
  'failure',
  'disabled',
] as const

export type ButtonLifecycleState = (typeof BUTTON_LIFECYCLE_STATES)[number]

export type ButtonLifecycleEvent =
  | { type: 'PRESS' }
  | { type: 'SUCCEED' }
  | { type: 'FAIL' }
  | { type: 'RESET' }
  | { type: 'DISABLE' }
  | { type: 'ENABLE' }

/**
 * Submit / action button lifecycle — idle → pending → success | failure.
 * Use for controls that represent an in-flight operation, not mere `disabled`.
 */
export const buttonLifecycleMachine = setup({
  types: {
    events: {} as ButtonLifecycleEvent,
  },
}).createMachine({
  id: 'buttonLifecycle',
  initial: 'idle',
  states: {
    idle: {
      on: {
        PRESS: 'pending',
        DISABLE: 'disabled',
      },
    },
    pending: {
      on: {
        SUCCEED: 'success',
        FAIL: 'failure',
        DISABLE: 'disabled',
      },
    },
    success: {
      on: {
        RESET: 'idle',
        PRESS: 'pending',
        DISABLE: 'disabled',
      },
    },
    failure: {
      on: {
        RESET: 'idle',
        PRESS: 'pending',
        DISABLE: 'disabled',
      },
    },
    disabled: {
      on: {
        ENABLE: 'idle',
      },
    },
  },
})
