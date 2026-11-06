import { assign, fromPromise, setup } from 'xstate'

/** What the checking side says about the digits a person typed. */
export type PairingOutcome =
  | { ok: true }
  | { ok: false; ended: boolean; attemptsLeft: number; message: string }

export type PairingCodeInput = {
  length: number
  attemptsLeft: number
  /** The new device checks the digits; nothing here knows the code. */
  confirm: (digits: string) => Promise<PairingOutcome>
  /** Presence check, then the sealed wallet goes to the new device. */
  approve: () => Promise<void>
}

export type PairingCodeContext = PairingCodeInput & {
  digits: string
  error: string | null
}

/**
 * Chart: pairingCode — a person types the numbers a new device shows (BRC-249).
 * States: entering → verifying → sending → approved | ended
 *
 * Typing is one digit at a time. A change of more than one character (autofill,
 * paste, drop) is ignored, so the code can only come from a person reading the
 * other screen. The sixth digit starts the check by itself; success is shown
 * only once the new device has accepted the code and the wallet was sent.
 */
export const pairingCodeMachine = setup({
  types: {
    context: {} as PairingCodeContext,
    input: {} as PairingCodeInput,
    events: {} as { type: 'TYPE'; value: string },
  },
  actors: {
    verify: fromPromise<PairingOutcome, { confirm: PairingCodeInput['confirm']; digits: string }>(({ input }) =>
      input.confirm(input.digits),
    ),
    send: fromPromise<void, { approve: PairingCodeInput['approve'] }>(({ input }) => input.approve()),
  },
  guards: {
    oneDigitMore: ({ context, event }) =>
      /^\d+$/.test(event.value) &&
      event.value.length === context.digits.length + 1 &&
      event.value.startsWith(context.digits) &&
      event.value.length <= context.length,
    oneLess: ({ context, event }) =>
      event.value.length === context.digits.length - 1 && context.digits.startsWith(event.value),
    complete: ({ context, event }) =>
      /^\d+$/.test(event.value) &&
      event.value.length === context.digits.length + 1 &&
      event.value.startsWith(context.digits) &&
      event.value.length === context.length,
  },
}).createMachine({
  id: 'pairingCode',
  initial: 'entering',
  context: ({ input }) => ({ ...input, digits: '', error: null }),
  states: {
    entering: {
      on: {
        TYPE: [
          { guard: 'complete', target: 'verifying', actions: assign({ digits: ({ event }) => event.value, error: null }) },
          { guard: 'oneDigitMore', actions: assign({ digits: ({ event }) => event.value, error: null }) },
          { guard: 'oneLess', actions: assign({ digits: ({ event }) => event.value }) },
          // Anything else (a pasted or autofilled run) is dropped on the floor.
        ],
      },
    },
    verifying: {
      invoke: {
        src: 'verify',
        input: ({ context }) => ({ confirm: context.confirm, digits: context.digits }),
        onDone: [
          { guard: ({ event }) => event.output.ok, target: 'sending' },
          {
            guard: ({ event }) => !event.output.ok && event.output.ended,
            target: 'ended',
            actions: assign({ error: ({ event }) => (event.output.ok ? null : event.output.message), digits: '' }),
          },
          {
            target: 'entering',
            actions: assign({
              digits: '',
              attemptsLeft: ({ event }) => (event.output.ok ? 0 : event.output.attemptsLeft),
              error: ({ event }) => (event.output.ok ? null : event.output.message),
            }),
          },
        ],
        onError: {
          target: 'entering',
          actions: assign({
            digits: '',
            error: ({ event }) => (event.error instanceof Error ? event.error.message : 'Could not reach the other device'),
          }),
        },
      },
    },
    sending: {
      invoke: {
        src: 'send',
        input: ({ context }) => ({ approve: context.approve }),
        onDone: { target: 'approved' },
        onError: {
          target: 'ended',
          actions: assign({
            error: ({ event }) => (event.error instanceof Error ? event.error.message : 'Could not send the wallet'),
          }),
        },
      },
    },
    approved: { type: 'final' },
    ended: { type: 'final' },
  },
})
