import { assign, setup } from 'xstate'

/**
 * Named user actions on an Activity row or the Activity list. Each is an
 * exclusive mutation of the failed / pending spend set, so at most one may be
 * in flight at a time.
 */
export type ActivityActionKind =
  | 'retry'
  | 'clear'
  | 'release'
  | 'reclaim'
  | 'cancelListing'
  | 'rebroadcastAll'
  | 'clearAll'
  | 'publishPending'

/** Copy for the confirm step; projected by the Aeon `Prompt` compound. */
export type ActivityActionConfirm = {
  title: string
  body: string
  confirmLabel: string
  /** Destructive actions render the primary as `btn-danger`. */
  danger?: boolean
}

export type ActivityActionContext = {
  /** Action awaiting confirmation, running, or the one that last failed. */
  action: ActivityActionKind | null
  confirm: ActivityActionConfirm | null
  error: string | null
}

export type ActivityActionEvent =
  | { type: 'REQUEST'; action: ActivityActionKind; confirm: ActivityActionConfirm }
  | { type: 'CONFIRM' }
  | { type: 'CANCEL' }
  | { type: 'START'; action: ActivityActionKind }
  | { type: 'SUCCEED' }
  | { type: 'FAIL'; error: string }
  | { type: 'RESET' }

/**
 * Chart: activityAction
 * States: idle → confirming → busy → idle | failure
 *                 ↘ idle (cancel)      idle → busy (no confirm step)
 *
 * Replaces the `retrying | clearing | releasing | …` boolean sets that
 * Activity panels used to hold side by side, and the `window.confirm` calls
 * that guarded them. `confirming` is a state the Prompt compound projects;
 * `busy` ignores START / REQUEST, so a second click or a sibling button cannot
 * start a competing mutation while one runs — the buttons read
 * `data-aeon-state` instead of OR-ing every flag together.
 */
export const activityActionMachine = setup({
  types: {
    context: {} as ActivityActionContext,
    events: {} as ActivityActionEvent,
  },
  actions: {
    request: assign({
      action: ({ event }) => (event.type === 'REQUEST' ? event.action : null),
      confirm: ({ event }) => (event.type === 'REQUEST' ? event.confirm : null),
      error: null,
    }),
    begin: assign({
      action: ({ event, context }) =>
        event.type === 'START' ? event.action : context.action,
      confirm: null,
      error: null,
    }),
    finish: assign({ action: null, confirm: null, error: null }),
    fail: assign({
      confirm: null,
      error: ({ event }) => (event.type === 'FAIL' ? event.error : null),
    }),
  },
}).createMachine({
  id: 'activityAction',
  initial: 'idle',
  context: { action: null, confirm: null, error: null },
  states: {
    idle: {
      on: {
        REQUEST: { target: 'confirming', actions: 'request' },
        START: { target: 'busy', actions: 'begin' },
      },
    },
    confirming: {
      on: {
        CONFIRM: { target: 'busy', actions: 'begin' },
        CANCEL: { target: 'idle', actions: 'finish' },
        RESET: { target: 'idle', actions: 'finish' },
      },
    },
    busy: {
      on: {
        SUCCEED: { target: 'idle', actions: 'finish' },
        FAIL: { target: 'failure', actions: 'fail' },
      },
    },
    failure: {
      on: {
        REQUEST: { target: 'confirming', actions: 'request' },
        START: { target: 'busy', actions: 'begin' },
        RESET: { target: 'idle', actions: 'finish' },
      },
    },
  },
})
