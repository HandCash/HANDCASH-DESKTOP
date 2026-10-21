import { assign, fromPromise, setup } from 'xstate'
import {
  advanceNewDeviceSignin,
  signinErrorText,
  type NewDeviceSignin,
  type SigninStep,
} from '../wallet/deviceSignin'
import type { VaultTransfer } from '../wallet/deviceTransfer'

export const RELAY_SIGNIN_POLL_MS = 2_000

export type RelaySigninContext = {
  signin: NewDeviceSignin
  code: string | null
  /** Last poll failed (a dropped network included); cleared by the next good read. */
  error: string | null
  transfer: VaultTransfer | null
  approverLabel: string | null
}

type StepOutput = { output: SigninStep }

/**
 * Chart: relaySignin — the new device waiting on the relay after the email code.
 * States: polling → resting → polling … → approved | refused | expired
 *
 * One read at a time: the next poll starts only after the last one settled, so
 * a slow relay can never reveal twice or hand the vault over twice.
 */
export const relaySigninMachine = setup({
  types: {
    context: {} as RelaySigninContext,
    input: {} as { signin: NewDeviceSignin },
  },
  actors: {
    advance: fromPromise<SigninStep, { signin: NewDeviceSignin }>(({ input }) =>
      advanceNewDeviceSignin(input.signin),
    ),
  },
  guards: {
    approved: ({ event }) => (event as unknown as StepOutput).output.state === 'approved',
    refused: ({ event }) => (event as unknown as StepOutput).output.state === 'refused',
    expired: ({ event }) => (event as unknown as StepOutput).output.state === 'expired',
  },
  delays: { poll: RELAY_SIGNIN_POLL_MS },
}).createMachine({
  id: 'relaySignin',
  initial: 'polling',
  context: ({ input }) => ({
    signin: input.signin,
    code: null,
    error: null,
    transfer: null,
    approverLabel: null,
  }),
  states: {
    polling: {
      invoke: {
        src: 'advance',
        input: ({ context }) => ({ signin: context.signin }),
        onDone: [
          {
            guard: 'approved',
            target: 'approved',
            actions: assign(({ event }) =>
              event.output.state === 'approved'
                ? { transfer: event.output.transfer, approverLabel: event.output.approverLabel, error: null }
                : {},
            ),
          },
          { guard: 'refused', target: 'refused' },
          { guard: 'expired', target: 'expired' },
          {
            target: 'resting',
            actions: assign(({ event }) => ({
              code: event.output.state === 'comparing' ? event.output.code : null,
              error: null,
            })),
          },
        ],
        onError: {
          target: 'resting',
          actions: assign({ error: ({ event }) => signinErrorText(event.error) }),
        },
      },
    },
    resting: {
      after: { poll: 'polling' },
    },
    approved: { type: 'final' },
    refused: { type: 'final' },
    expired: { type: 'final' },
  },
})
