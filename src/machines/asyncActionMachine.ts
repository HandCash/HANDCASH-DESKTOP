import { assign, setup } from 'xstate'

/**
 * Copy for a confirm step; projected by the Aeon `Prompt` compound
 * (`AsyncActionPrompt`). Replaces `window.confirm`.
 */
export type AsyncActionConfirm = {
  title: string
  body: string
  confirmLabel: string
  /** Secondary label; defaults to "Cancel". */
  cancelLabel?: string
  /** Destructive actions render the primary as `btn-danger`. */
  danger?: boolean
}

export type AsyncActionContext = {
  /**
   * Named action awaiting confirmation, running, or the one that last failed.
   * Callers narrow this to their own union via `useAsyncAction<Kind>()`.
   */
  action: string | null
  confirm: AsyncActionConfirm | null
  error: string | null
}

export type AsyncActionEvent =
  | { type: 'REQUEST'; action: string; confirm: AsyncActionConfirm }
  | { type: 'CONFIRM' }
  | { type: 'CANCEL' }
  | { type: 'START'; action: string }
  | { type: 'SUCCEED' }
  | { type: 'FAIL'; error: string }
  | { type: 'RESET' }

/**
 * Chart: asyncAction
 * States: idle → confirming → busy → idle | failure
 *                 ↘ idle (cancel)      idle → busy (no confirm step)
 *
 * One exclusive user-initiated mutation for a panel: submit, save, retry,
 * clear, combine, upload. Replaces the `busy` / `submitting` / `retrying |
 * clearing | …` booleans that panels set before an `await` and cleared in
 * `finally`, and the `window.confirm` calls that guarded them. `busy` ignores
 * START / REQUEST, so a second click or a sibling button cannot start a
 * competing mutation — buttons read `data-aeon-state` instead of OR-ing flags.
 */
export const asyncActionMachine = setup({
  types: {
    context: {} as AsyncActionContext,
    events: {} as AsyncActionEvent,
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
  id: 'asyncAction',
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
