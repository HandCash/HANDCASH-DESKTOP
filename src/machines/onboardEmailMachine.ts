import { assign, fromPromise, setup } from 'xstate'
import {
  registerSigninEmail,
  requestSigninCode,
  setSigninEmail,
  signinErrorText,
  walletSigninKeyHex,
} from '../wallet/deviceSignin'

export type OnboardEmailContext = {
  email: string
  code: string
  requestId: string | null
  error: string | null
}

export type OnboardEmailEvent =
  | { type: 'EDIT_EMAIL'; email: string }
  | { type: 'EDIT_CODE'; code: string }
  | { type: 'SEND' }
  | { type: 'CONFIRM' }
  | { type: 'BACK' }
  | { type: 'SKIP' }

export function onboardEmailCode(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, 6)
}

/**
 * Chart: onboardEmail — a new wallet's optional sign-in email during onboarding.
 * States: entering → sending → code → saving → saved, or skipped from entering or code.
 *
 * The address is saved only after its emailed code proves it; skipping leaves
 * Settings → Sign-in email to add it later.
 */
export const onboardEmailMachine = setup({
  types: {
    context: {} as OnboardEmailContext,
    events: {} as OnboardEmailEvent,
  },
  actors: {
    sendCode: fromPromise<{ requestId: string; devCode?: string }, { email: string }>(({ input }) =>
      requestSigninCode(input.email, 'register'),
    ),
    register: fromPromise<string, { requestId: string; code: string }>(async ({ input }) => {
      const result = await registerSigninEmail(walletSigninKeyHex(), input.requestId, input.code)
      setSigninEmail(result.email)
      return result.email
    }),
  },
  guards: {
    hasEmail: ({ context }) => context.email.trim().length > 0,
    hasCode: ({ context }) => context.code.length === 6 && context.requestId !== null,
  },
}).createMachine({
  id: 'onboardEmail',
  initial: 'entering',
  context: { email: '', code: '', requestId: null, error: null },
  states: {
    entering: {
      on: {
        EDIT_EMAIL: { actions: assign({ email: ({ event }) => event.email }) },
        SEND: { guard: 'hasEmail', target: 'sending' },
        SKIP: 'skipped',
      },
    },
    sending: {
      entry: assign({ error: null }),
      invoke: {
        src: 'sendCode',
        input: ({ context }) => ({ email: context.email.trim() }),
        onDone: {
          target: 'code',
          actions: assign(({ event }) => ({
            requestId: event.output.requestId,
            code: onboardEmailCode(event.output.devCode ?? ''),
          })),
        },
        onError: {
          target: 'entering',
          actions: assign({ error: ({ event }) => signinErrorText(event.error) }),
        },
      },
    },
    code: {
      on: {
        EDIT_CODE: { actions: assign({ code: ({ event }) => onboardEmailCode(event.code) }) },
        CONFIRM: { guard: 'hasCode', target: 'saving' },
        BACK: {
          target: 'entering',
          actions: assign({ code: '', requestId: null, error: null }),
        },
        SKIP: 'skipped',
      },
    },
    saving: {
      entry: assign({ error: null }),
      invoke: {
        src: 'register',
        input: ({ context }) => ({ requestId: context.requestId ?? '', code: context.code }),
        onDone: {
          target: 'saved',
          actions: assign({ email: ({ event }) => event.output }),
        },
        onError: {
          target: 'code',
          actions: assign({ error: ({ event }) => signinErrorText(event.error) }),
        },
      },
    },
    saved: { type: 'final' },
    skipped: { type: 'final' },
  },
})
