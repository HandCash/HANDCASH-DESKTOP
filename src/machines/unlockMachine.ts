import { setup, assign } from 'xstate'
import { UNLOCK_PASSWORD_MIN_LENGTH } from '../wallet/passwordPolicy'

/** How an attempt opens the vault. */
export type UnlockFactor = 'password' | 'device' | 'open-secret' | 'create' | 'restore' | 'approved'

/** Why the last attempt ended without opening the wallet. */
export type UnlockFailReason =
  | 'device-cancelled'
  | 'device-failed'
  | 'open-secret-failed'
  | 'password-failed'
  | 'setup-failed'

/** What the auth screen shows while the vault opens. */
export type UnlockProgress = { title: string; lede: string }

export type UnlockContext = {
  password: string
  error: string | null
  factor: UnlockFactor | null
  reason: UnlockFailReason | null
  progress: UnlockProgress | null
  /** The lock screen prompts this device by itself at most once. */
  deviceTried: boolean
}

export type UnlockEvent =
  | { type: 'CHANGE'; password: string }
  | { type: 'SUBMIT' }
  | { type: 'START'; factor: 'create' | 'restore' | 'approved'; progress: UnlockProgress }
  | { type: 'OPEN_SECRET' }
  | { type: 'DEVICE'; auto: boolean; visible: boolean }
  | { type: 'VISIBLE' }
  | { type: 'UNLOCKED' }
  | { type: 'PROGRESS'; progress: UnlockProgress }
  | { type: 'SUCCESS' }
  | { type: 'FAIL'; error: string; cancelled?: boolean }
  | { type: 'RETRY' }

export const DEVICE_PROGRESS: UnlockProgress = {
  title: 'Unlocking',
  lede: 'Confirm with this device…',
}
export const PASSWORD_PROGRESS: UnlockProgress = {
  title: 'Unlocking',
  lede: 'Opening your wallet on this device.',
}
export const OPEN_SECRET_PROGRESS: UnlockProgress = {
  title: 'Opening',
  lede: 'Opening your wallet on this device.',
}

export function failReason(factor: UnlockFactor | null, cancelled: boolean): UnlockFailReason {
  if (factor === 'device') return cancelled ? 'device-cancelled' : 'device-failed'
  if (factor === 'open-secret') return 'open-secret-failed'
  if (factor === 'password') return 'password-failed'
  return 'setup-failed'
}

/**
 * Chart: unlockForm
 * States: idle → waitingForVisible → awaitingDevice → opening → success | failed
 *
 * One chart for every way the auth screen opens a vault: password, this
 * device's Touch ID, the open secret when device lock is off, and create,
 * restore or an approved sign-in. `progress` is what the screen shows while
 * busy and `failed` keeps the reason. The lock screen prompts this device by
 * itself once (`deviceTried`); the fingerprint button can always ask again.
 * Touch ID never prompts by itself while the window is hidden: it waits for
 * VISIBLE, and the screen stays usable meanwhile.
 */
export const unlockMachine = setup({
  types: {
    context: {} as UnlockContext,
    events: {} as UnlockEvent,
  },
  guards: {
    passwordLongEnough: ({ context }) => context.password.length >= UNLOCK_PASSWORD_MIN_LENGTH,
    deviceAllowed: ({ context, event }) =>
      event.type === 'DEVICE' && !(event.auto && context.deviceTried),
    deviceShown: ({ context, event }) =>
      event.type === 'DEVICE' && event.visible && !(event.auto && context.deviceTried),
    manualDevice: ({ event }) => event.type === 'DEVICE' && !event.auto,
  },
  actions: {
    typePassword: assign(({ event }) =>
      event.type === 'CHANGE' ? { password: event.password, error: null, reason: null } : {},
    ),
    clearFailure: assign({ error: null, reason: null }),
    startPassword: assign({ factor: 'password', progress: PASSWORD_PROGRESS }),
    startSetup: assign(({ event }) =>
      event.type === 'START' ? { factor: event.factor, progress: event.progress } : {},
    ),
    startOpenSecret: assign({
      factor: 'open-secret',
      progress: OPEN_SECRET_PROGRESS,
      deviceTried: true,
    }),
    startDevice: assign({ factor: 'device' }),
    showDevicePrompt: assign({ progress: DEVICE_PROGRESS, deviceTried: true }),
    setProgress: assign(({ event }) =>
      event.type === 'PROGRESS' ? { progress: event.progress } : {},
    ),
    clearProgress: assign({ progress: null }),
    recordFailure: assign(({ context, event }) =>
      event.type === 'FAIL'
        ? {
            error: event.cancelled ? '' : event.error,
            reason: failReason(context.factor, Boolean(event.cancelled)),
          }
        : {},
    ),
  },
}).createMachine({
  id: 'unlockForm',
  initial: 'idle',
  context: {
    password: '',
    error: null,
    factor: null,
    reason: null,
    progress: null,
    deviceTried: false,
  },
  states: {
    idle: {
      on: {
        CHANGE: { actions: 'typePassword' },
        SUBMIT: { guard: 'passwordLongEnough', target: 'opening', actions: 'startPassword' },
        START: { target: 'opening', actions: 'startSetup' },
        OPEN_SECRET: { target: 'opening', actions: 'startOpenSecret' },
        DEVICE: [
          { guard: 'deviceShown', target: 'awaitingDevice', actions: 'startDevice' },
          { guard: 'deviceAllowed', target: 'waitingForVisible', actions: 'startDevice' },
        ],
      },
    },
    waitingForVisible: {
      on: {
        VISIBLE: 'awaitingDevice',
        CHANGE: { actions: 'typePassword' },
        SUBMIT: { guard: 'passwordLongEnough', target: 'opening', actions: 'startPassword' },
        START: { target: 'opening', actions: 'startSetup' },
        DEVICE: { guard: 'manualDevice', target: 'awaitingDevice' },
      },
    },
    awaitingDevice: {
      entry: 'showDevicePrompt',
      on: {
        UNLOCKED: 'opening',
        FAIL: { target: 'failed', actions: 'recordFailure' },
      },
    },
    opening: {
      entry: 'clearFailure',
      on: {
        PROGRESS: { actions: 'setProgress' },
        SUCCESS: { target: 'success', actions: 'clearProgress' },
        FAIL: { target: 'failed', actions: 'recordFailure' },
      },
    },
    success: { type: 'final' },
    failed: {
      entry: 'clearProgress',
      on: {
        RETRY: { target: 'idle', actions: 'clearFailure' },
        CHANGE: { target: 'idle', actions: 'typePassword' },
        SUBMIT: { guard: 'passwordLongEnough', target: 'opening', actions: 'startPassword' },
        START: { target: 'opening', actions: 'startSetup' },
        OPEN_SECRET: { target: 'opening', actions: 'startOpenSecret' },
        DEVICE: [
          { guard: 'deviceShown', target: 'awaitingDevice', actions: 'startDevice' },
          { guard: 'deviceAllowed', target: 'waitingForVisible', actions: 'startDevice' },
        ],
      },
    },
  },
})
