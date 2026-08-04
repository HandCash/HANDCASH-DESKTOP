import { setup } from 'xstate'

export const FIELD_INTERACTION_STATES = ['pristine', 'dirty'] as const
export const FIELD_VALIDATION_STATES = ['valid', 'invalid'] as const
export const FIELD_SUBMISSION_STATES = ['idle', 'pending'] as const

export type FieldInteractionState = (typeof FIELD_INTERACTION_STATES)[number]
export type FieldValidationState = (typeof FIELD_VALIDATION_STATES)[number]
export type FieldSubmissionState = (typeof FIELD_SUBMISSION_STATES)[number]

export type FieldEvent =
  | { type: 'INPUT' }
  | { type: 'BLUR' }
  | { type: 'VALIDATE'; valid: boolean }
  | { type: 'SUBMIT' }
  | { type: 'SUBMIT_DONE' }
  | { type: 'SUBMIT_FAIL' }
  | { type: 'RESET' }

/**
 * Orthogonal field regions — interaction, validation, and submission evolve independently.
 * Snapshot value is nested; flatten with `stateToAttr` for `data-aeon-state`.
 */
export const fieldMachine = setup({
  types: {
    events: {} as FieldEvent,
  },
}).createMachine({
  id: 'field',
  type: 'parallel',
  states: {
    interaction: {
      initial: 'pristine',
      states: {
        pristine: {
          on: {
            INPUT: 'dirty',
            BLUR: 'dirty',
          },
        },
        dirty: {
          on: {
            RESET: 'pristine',
          },
        },
      },
    },
    validation: {
      initial: 'valid',
      states: {
        valid: {
          on: {
            VALIDATE: [
              { target: 'invalid', guard: ({ event }) => event.type === 'VALIDATE' && !event.valid },
            ],
          },
        },
        invalid: {
          on: {
            VALIDATE: [
              { target: 'valid', guard: ({ event }) => event.type === 'VALIDATE' && event.valid },
            ],
            RESET: 'valid',
          },
        },
      },
    },
    submission: {
      initial: 'idle',
      states: {
        idle: {
          on: {
            SUBMIT: 'pending',
          },
        },
        pending: {
          on: {
            SUBMIT_DONE: 'idle',
            SUBMIT_FAIL: 'idle',
          },
        },
      },
    },
  },
})
