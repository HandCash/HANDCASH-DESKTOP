import { playSound } from '@aeon-ui/core'
import { fromPromise, setup } from 'xstate'

/**
 * Copy-to-clipboard feedback.
 *
 * Events: COPY { value } writes `value` to the system clipboard.
 * States: idle → copying → copied | failed, back to idle after `timeout` ms. COPY again restarts.
 * Entering copied / failed plays the `copy` / `error` sound (silent unless the app enabled sounds).
 */
export interface ClipboardContext {
  /** How long `copied` / `failed` show before returning to idle, in ms. */
  timeout: number
}

export type ClipboardEvent = { type: 'COPY'; value: string }

export const CLIPBOARD_STATES = ['idle', 'copying', 'copied', 'failed'] as const
export type ClipboardStatus = (typeof CLIPBOARD_STATES)[number]

export const clipboardMachine = setup({
  types: {
    context: {} as ClipboardContext,
    events: {} as ClipboardEvent,
    input: {} as Partial<ClipboardContext> | undefined,
  },
  actors: {
    write: fromPromise<void, { value: string }>(async ({ input }) => {
      await navigator.clipboard.writeText(input.value)
    }),
  },
  actions: {
    soundCopied: () => playSound('copy'),
    soundFailed: () => playSound('error'),
  },
  delays: {
    timeout: ({ context }) => context.timeout,
  },
}).createMachine({
  id: 'clipboard',
  context: ({ input }) => ({ timeout: input?.timeout ?? 1500 }),
  initial: 'idle',
  states: {
    idle: { on: { COPY: 'copying' } },
    copying: {
      invoke: {
        src: 'write',
        input: ({ event }) => ({ value: (event as ClipboardEvent).value }),
        onDone: 'copied',
        onError: 'failed',
      },
    },
    copied: { entry: 'soundCopied', after: { timeout: 'idle' }, on: { COPY: 'copying' } },
    failed: { entry: 'soundFailed', after: { timeout: 'idle' }, on: { COPY: 'copying' } },
  },
})
