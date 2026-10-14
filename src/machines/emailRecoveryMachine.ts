import { assign, setup } from 'xstate'

export type EmailRecoveryEvent =
  | { type: 'ENROLL' }
  | { type: 'BROWSER_OPENED' }
  | { type: 'GOOGLE_VERIFIED'; email: string }
  | { type: 'MAIL_SENT' }
  | { type: 'CONFIRM_MAILBOX' }
  | { type: 'MAIL_CONFIRMED' }
  | { type: 'LOGIN' }
  | { type: 'DEVICE_FOUND' }
  | { type: 'DEVICE_CHALLENGED'; code: string }
  | { type: 'DEVICE_APPROVED' }
  | { type: 'WAIT_FOR_RECOVERY'; releaseAt: number }
  | { type: 'RECOVERY_RELEASED' }
  | { type: 'RESTORED' }
  | { type: 'CANCEL' }
  | { type: 'FAIL'; message: string }

type EmailRecoveryContext = {
  email: string | null
  comparisonCode: string | null
  releaseAt: number | null
  error: string | null
}

export const emailRecoveryMachine = setup({
  types: {
    context: {} as EmailRecoveryContext,
    events: {} as EmailRecoveryEvent,
  },
  actions: {
    googleVerified: assign(({ event }) =>
      event.type === 'GOOGLE_VERIFIED'
        ? { email: event.email, error: null }
        : {},
    ),
    challenged: assign(({ event }) =>
      event.type === 'DEVICE_CHALLENGED'
        ? { comparisonCode: event.code, error: null }
        : {},
    ),
    waiting: assign(({ event }) =>
      event.type === 'WAIT_FOR_RECOVERY'
        ? { releaseAt: event.releaseAt, error: null }
        : {},
    ),
    failed: assign(({ event }) =>
      event.type === 'FAIL' ? { error: event.message } : {},
    ),
    clear: assign({
      comparisonCode: null,
      releaseAt: null,
      error: null,
    }),
  },
}).createMachine({
  id: 'emailRecovery',
  initial: 'idle',
  context: {
    email: null,
    comparisonCode: null,
    releaseAt: null,
    error: null,
  },
  on: {
    FAIL: { target: '.failed', actions: 'failed' },
    CANCEL: { target: '.idle', actions: 'clear' },
  },
  states: {
    idle: {
      on: {
        ENROLL: { target: 'enrolling.openingBrowser', actions: 'clear' },
        LOGIN: { target: 'login.openingBrowser', actions: 'clear' },
      },
    },
    enrolling: {
      initial: 'openingBrowser',
      states: {
        openingBrowser: {
          on: { BROWSER_OPENED: { target: 'waitingForGoogle' } },
        },
        waitingForGoogle: {
          on: {
            GOOGLE_VERIFIED: {
              target: 'mailingShare',
              actions: 'googleVerified',
            },
          },
        },
        mailingShare: {
          on: { MAIL_SENT: { target: 'confirmingMailbox' } },
        },
        confirmingMailbox: {
          on: { CONFIRM_MAILBOX: { target: 'depositingHostShare' } },
        },
        depositingHostShare: {
          on: { MAIL_CONFIRMED: { target: '#emailRecovery.ready' } },
        },
      },
    },
    ready: {
      on: {
        LOGIN: { target: 'login.openingBrowser', actions: 'clear' },
      },
    },
    login: {
      initial: 'openingBrowser',
      states: {
        openingBrowser: {
          on: { BROWSER_OPENED: { target: 'waitingForGoogle' } },
        },
        waitingForGoogle: {
          on: {
            DEVICE_FOUND: { target: 'waitingForChallenge' },
            WAIT_FOR_RECOVERY: {
              target: 'delayedRecovery',
              actions: 'waiting',
            },
          },
        },
        waitingForChallenge: {
          on: {
            DEVICE_CHALLENGED: {
              target: 'comparing',
              actions: 'challenged',
            },
          },
        },
        comparing: {
          on: { DEVICE_APPROVED: { target: 'restoring' } },
        },
        delayedRecovery: {
          on: { RECOVERY_RELEASED: { target: 'awaitingMailbox' } },
        },
        awaitingMailbox: {
          on: { CONFIRM_MAILBOX: { target: 'restoring' } },
        },
        restoring: {
          on: { RESTORED: { target: '#emailRecovery.complete' } },
        },
      },
    },
    complete: { type: 'final' },
    failed: {
      on: {
        ENROLL: { target: 'enrolling.openingBrowser', actions: 'clear' },
        LOGIN: { target: 'login.openingBrowser', actions: 'clear' },
      },
    },
  },
})
