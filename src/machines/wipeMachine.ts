import { setup, assign } from 'xstate'
import type { WipeHistoryGate, WipeHistoryRefusal } from '../wallet/wipeHistoryGate'

export type WipeContext = {
  /** HandCash password when used; empty string means device factor already verified. */
  password: string
  /** True after ConfirmPasswordGate succeeds (password or device). */
  unlocked: boolean
  confirmText: string
  acknowledged: boolean
  error: string | null
  /** Proof the history replica holds localState; wipe refuses without it. */
  gate: WipeHistoryGate | null
  /** Why the history gate refused; OVERRIDE names it in the log. */
  refusal: WipeHistoryRefusal | null
}

/**
 * Chart: wipeWallet
 * States: idle → syncing → wiping → success | failure; syncing → blocked;
 * blocked → wiping only through OVERRIDE (loss named and confirmed)
 */
export const wipeMachine = setup({
  types: {
    context: {} as WipeContext,
    events: {} as
      | { type: 'CHANGE_PASSWORD'; password: string }
      | { type: 'VERIFIED'; password: string | null }
      | { type: 'CHANGE_CONFIRM'; confirmText: string }
      | { type: 'TOGGLE_ACK'; acknowledged: boolean }
      | { type: 'SUBMIT' }
      | { type: 'SYNCED'; gate: WipeHistoryGate }
      | { type: 'BLOCKED'; reason: string; refusal: WipeHistoryRefusal }
      | { type: 'OVERRIDE'; gate: WipeHistoryGate }
      | { type: 'BACK' }
      | { type: 'SUCCESS' }
      | { type: 'FAIL'; error: string }
      | { type: 'RETRY' },
  },
}).createMachine({
  id: 'wipeWallet',
  initial: 'idle',
  context: {
    password: '',
    unlocked: false,
    confirmText: '',
    acknowledged: false,
    error: null,
    gate: null,
    refusal: null,
  },
  states: {
    idle: {
      on: {
        CHANGE_PASSWORD: {
          actions: assign({
            password: ({ event }) => event.password,
            unlocked: true,
            error: null,
          }),
        },
        VERIFIED: {
          actions: assign({
            password: ({ event }) => event.password ?? '',
            unlocked: true,
            error: null,
          }),
        },
        CHANGE_CONFIRM: {
          actions: assign({
            confirmText: ({ event }) => event.confirmText,
            error: null,
          }),
        },
        TOGGLE_ACK: {
          actions: assign({
            acknowledged: ({ event }) => event.acknowledged,
            error: null,
          }),
        },
        SUBMIT: {
          guard: ({ context }) =>
            context.unlocked &&
            context.acknowledged &&
            context.confirmText.trim().toUpperCase() === 'DELETE',
          target: 'syncing',
          actions: assign({ gate: null, error: null }),
        },
      },
    },
    syncing: {
      on: {
        SYNCED: {
          target: 'wiping',
          actions: assign({ gate: ({ event }) => event.gate }),
        },
        BLOCKED: {
          target: 'blocked',
          actions: assign({
            error: ({ event }) => event.reason,
            refusal: ({ event }) => event.refusal,
          }),
        },
      },
    },
    blocked: {
      on: {
        OVERRIDE: {
          guard: ({ event }) => event.gate.kind === 'overridden',
          target: 'wiping',
          actions: assign({ gate: ({ event }) => event.gate, error: null }),
        },
        RETRY: {
          target: 'syncing',
          actions: assign({ error: null }),
        },
        BACK: {
          target: 'idle',
          actions: assign({ error: null }),
        },
      },
    },
    wiping: {
      on: {
        SUCCESS: 'success',
        FAIL: {
          target: 'failure',
          actions: assign({ error: ({ event }) => event.error }),
        },
      },
    },
    success: { type: 'final' },
    failure: {
      on: {
        RETRY: {
          target: 'idle',
          actions: assign({ error: null }),
        },
        CHANGE_PASSWORD: {
          target: 'idle',
          actions: assign({
            password: ({ event }) => event.password,
            unlocked: true,
            error: null,
          }),
        },
        VERIFIED: {
          target: 'idle',
          actions: assign({
            password: ({ event }) => event.password ?? '',
            unlocked: true,
            error: null,
          }),
        },
        CHANGE_CONFIRM: {
          target: 'idle',
          actions: assign({
            confirmText: ({ event }) => event.confirmText,
            error: null,
          }),
        },
        TOGGLE_ACK: {
          target: 'idle',
          actions: assign({
            acknowledged: ({ event }) => event.acknowledged,
            error: null,
          }),
        },
      },
    },
  },
})
