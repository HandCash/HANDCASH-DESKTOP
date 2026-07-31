import { assign, setup } from 'xstate'

export type UpdateMode = 'default' | 'manual' | 'none'

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'ready'
  | 'error'

export type UpdateStatus = {
  phase: UpdatePhase
  mode: UpdateMode
  currentVersion: string
  availableVersion: string | null
  percent: number | null
  error: string | null
  canInstall: boolean
}

export type UpdateContext = UpdateStatus & {
  /** Restart prompt dismissed for this availableVersion (session). */
  promptDismissedVersion: string | null
}

function phaseState(phase: UpdatePhase) {
  return phase === 'not-available' ? 'notAvailable' : phase
}

/**
 * Chart: appUpdate
 * States: idle → checking → available → downloading → ready | notAvailable | error
 * Mode lives in context (default | manual | none) — Cursor-style update.mode.
 * UI = f(snapshot): toast / prompt / settings all project data-aeon-state from value.
 */
export const updateMachine = setup({
  types: {
    context: {} as UpdateContext,
    events: {} as
      | { type: 'SYNC'; status: UpdateStatus }
      | { type: 'CHECK' }
      | { type: 'SET_MODE'; mode: UpdateMode }
      | { type: 'DOWNLOAD' }
      | { type: 'INSTALL' }
      | { type: 'DISMISS_PROMPT' }
      | { type: 'OPEN_PROMPT' },
  },
  actions: {
    applyStatus: assign(({ event }) => {
      if (event.type !== 'SYNC') return {}
      const s = event.status
      return {
        phase: s.phase,
        mode: s.mode,
        currentVersion: s.currentVersion,
        availableVersion: s.availableVersion,
        percent: s.percent,
        error: s.error,
        canInstall: s.canInstall,
      }
    }),
    setMode: assign({
      mode: ({ event }) => (event.type === 'SET_MODE' ? event.mode : 'default'),
    }),
    markChecking: assign({
      phase: 'checking' as const,
      error: null,
    }),
    markDownloading: assign({
      phase: 'downloading' as const,
      percent: ({ context }) => context.percent ?? 0,
      error: null,
    }),
    dismissPrompt: assign({
      promptDismissedVersion: ({ context }) => context.availableVersion,
    }),
    clearDismiss: assign({
      promptDismissedVersion: null,
    }),
  },
  guards: {
    promptOpen: ({ context }) =>
      context.canInstall &&
      context.phase === 'ready' &&
      context.promptDismissedVersion !== context.availableVersion,
  },
}).createMachine({
  id: 'appUpdate',
  initial: 'idle',
  context: {
    phase: 'idle',
    mode: 'default',
    currentVersion: '0.0.0',
    availableVersion: null,
    percent: null,
    error: null,
    canInstall: false,
    promptDismissedVersion: null,
  },
  on: {
    SET_MODE: { actions: 'setMode' },
    DISMISS_PROMPT: { actions: 'dismissPrompt' },
    OPEN_PROMPT: { actions: 'clearDismiss' },
    SYNC: [
      {
        guard: ({ event }) => event.status.phase === 'checking',
        target: `.${phaseState('checking')}`,
        actions: 'applyStatus',
      },
      {
        guard: ({ event }) => event.status.phase === 'available',
        target: `.${phaseState('available')}`,
        actions: 'applyStatus',
      },
      {
        guard: ({ event }) => event.status.phase === 'downloading',
        target: `.${phaseState('downloading')}`,
        actions: 'applyStatus',
      },
      {
        guard: ({ event }) => event.status.phase === 'ready',
        target: `.${phaseState('ready')}`,
        actions: 'applyStatus',
      },
      {
        guard: ({ event }) => event.status.phase === 'not-available',
        target: `.${phaseState('not-available')}`,
        actions: 'applyStatus',
      },
      {
        guard: ({ event }) => event.status.phase === 'error',
        target: `.${phaseState('error')}`,
        actions: 'applyStatus',
      },
      {
        guard: ({ event }) => event.status.phase === 'idle',
        target: `.${phaseState('idle')}`,
        actions: 'applyStatus',
      },
    ],
  },
  states: {
    idle: {
      on: {
        CHECK: { target: 'checking', actions: 'markChecking' },
      },
    },
    checking: {
      on: {
        CHECK: { target: 'checking', actions: 'markChecking', reenter: true },
      },
    },
    available: {
      on: {
        DOWNLOAD: { target: 'downloading', actions: 'markDownloading' },
        CHECK: { target: 'checking', actions: 'markChecking' },
      },
    },
    downloading: {},
    ready: {},
    notAvailable: {
      on: {
        CHECK: { target: 'checking', actions: 'markChecking' },
      },
    },
    error: {
      on: {
        CHECK: { target: 'checking', actions: 'markChecking' },
      },
    },
  },
})

export function updateStateAttr(value: unknown, context: UpdateContext): string {
  const phase =
    typeof value === 'string'
      ? value === 'notAvailable'
        ? 'not-available'
        : value
      : context.phase
  const parts = [phase, `mode-${context.mode}`]
  if (context.canInstall) parts.push('can-install')
  if (
    context.canInstall &&
    context.phase === 'ready' &&
    context.promptDismissedVersion !== context.availableVersion
  ) {
    parts.push('prompt-open')
  }
  return parts.join(' ')
}
