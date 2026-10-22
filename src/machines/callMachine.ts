import { assign, setup } from 'xstate'

/** How a call ended, as Activity and the far side read it. */
export type CallOutcome =
  | 'finished'
  | 'missed'
  | 'declined'
  | 'no-answer'
  | 'busy'
  | 'unreachable'
  | 'cancelled'
  | 'failed'

export type CallDirection = 'out' | 'in'

export const CALL_RING_MS = 45_000
export const CALL_CONNECT_MS = 20_000
export const CALL_REACH_MS = 40_000
export const CALL_ENDED_LINGER_MS = 2_500

export type CallContext = {
  callId: string | null
  peer: string | null
  direction: CallDirection
  video: boolean
  muted: boolean
  remoteMuted: boolean
  startedAt: number
  connectedAt: number | null
  endedAt: number | null
  outcome: CallOutcome | null
  /** Why a `failed` call failed, in the user's words. */
  failure: string | null
}

export type CallEvent =
  | { type: 'DIAL'; callId: string; peer: string; video: boolean; at: number }
  | { type: 'INCOMING'; callId: string; peer: string; video: boolean; at: number }
  | { type: 'REACHED' }
  | { type: 'UNREACHABLE'; at: number }
  | { type: 'ACCEPT' }
  | { type: 'REMOTE_ACCEPTED' }
  | { type: 'DECLINE'; at: number }
  | { type: 'REMOTE_DECLINED'; busy: boolean; at: number }
  | { type: 'MEDIA_CONNECTED'; at: number }
  | { type: 'FAIL'; reason: string; at: number }
  | { type: 'HANG_UP'; at: number }
  | { type: 'REMOTE_HUNG_UP'; at: number }
  | { type: 'TOGGLE_MUTE' }
  | { type: 'REMOTE_STATE'; muted: boolean }
  | { type: 'DISMISS' }

const blank: CallContext = {
  callId: null,
  peer: null,
  direction: 'out',
  video: false,
  muted: false,
  remoteMuted: false,
  startedAt: 0,
  connectedAt: null,
  endedAt: null,
  outcome: null,
  failure: null,
}

function eventAt(event: { type: string }): number {
  return 'at' in event && typeof event.at === 'number' ? event.at : Date.now()
}

const endAs = (outcome: CallOutcome) => [{ type: 'end' as const, params: { outcome } }]

/**
 * One call, from dial or ring to its outcome. The engine (`callEngine.ts`)
 * sends the events and reacts to the states: it rings in `incoming`, plays
 * ringback in `outgoing.ringing`, opens media from `connecting`, and writes
 * Activity once on `ended`. Every wait has its own timeout, so no call hangs.
 */
export const callMachine = setup({
  types: {
    context: {} as CallContext,
    events: {} as CallEvent,
  },
  delays: {
    ring: CALL_RING_MS,
    connect: CALL_CONNECT_MS,
    reach: CALL_REACH_MS,
    linger: CALL_ENDED_LINGER_MS,
  },
  actions: {
    begin: assign(({ event }) => {
      if (event.type !== 'DIAL' && event.type !== 'INCOMING') return {}
      return {
        ...blank,
        callId: event.callId,
        peer: event.peer,
        direction: event.type === 'DIAL' ? ('out' as const) : ('in' as const),
        video: event.video,
        startedAt: event.at,
      }
    }),
    connected: assign(({ event }) => ({ connectedAt: eventAt(event) })),
    end: assign(({ event }, params: { outcome: CallOutcome }) => ({
      outcome: params.outcome,
      endedAt: eventAt(event),
      failure: event.type === 'FAIL' ? event.reason : null,
    })),
    reset: assign(() => ({ ...blank })),
    toggleMute: assign(({ context }) => ({ muted: !context.muted })),
    remoteState: assign(({ event }) => (event.type === 'REMOTE_STATE' ? { remoteMuted: event.muted } : {})),
  },
}).createMachine({
  id: 'call',
  initial: 'idle',
  context: { ...blank },
  states: {
    idle: {
      on: {
        DIAL: { target: 'outgoing', actions: 'begin' },
        INCOMING: { target: 'incoming', actions: 'begin' },
      },
    },
    outgoing: {
      initial: 'reaching',
      on: {
        HANG_UP: { target: 'ended', actions: endAs('cancelled') },
        FAIL: { target: 'ended', actions: endAs('failed') },
        TOGGLE_MUTE: { actions: 'toggleMute' },
      },
      states: {
        reaching: {
          after: { reach: { target: '#call.ended', actions: endAs('unreachable') } },
          on: {
            REACHED: 'ringing',
            REMOTE_ACCEPTED: '#call.connecting',
            UNREACHABLE: { target: '#call.ended', actions: endAs('unreachable') },
          },
        },
        ringing: {
          after: { ring: { target: '#call.ended', actions: endAs('no-answer') } },
          on: {
            REMOTE_ACCEPTED: '#call.connecting',
            REMOTE_DECLINED: [
              { guard: ({ event }) => event.busy, target: '#call.ended', actions: endAs('busy') },
              { target: '#call.ended', actions: endAs('declined') },
            ],
          },
        },
      },
    },
    incoming: {
      after: { ring: { target: 'ended', actions: endAs('missed') } },
      on: {
        ACCEPT: 'connecting',
        DECLINE: { target: 'ended', actions: endAs('declined') },
        REMOTE_HUNG_UP: { target: 'ended', actions: endAs('missed') },
      },
    },
    connecting: {
      after: { connect: { target: 'ended', actions: endAs('failed') } },
      on: {
        MEDIA_CONNECTED: { target: 'active', actions: 'connected' },
        FAIL: { target: 'ended', actions: endAs('failed') },
        HANG_UP: { target: 'ended', actions: endAs('cancelled') },
        REMOTE_HUNG_UP: { target: 'ended', actions: endAs('cancelled') },
        TOGGLE_MUTE: { actions: 'toggleMute' },
        REMOTE_STATE: { actions: 'remoteState' },
      },
    },
    active: {
      on: {
        HANG_UP: { target: 'ended', actions: endAs('finished') },
        REMOTE_HUNG_UP: { target: 'ended', actions: endAs('finished') },
        FAIL: { target: 'ended', actions: endAs('failed') },
        TOGGLE_MUTE: { actions: 'toggleMute' },
        REMOTE_STATE: { actions: 'remoteState' },
      },
    },
    ended: {
      after: { linger: { target: 'idle', actions: 'reset' } },
      on: {
        DISMISS: { target: 'idle', actions: 'reset' },
        DIAL: { target: 'outgoing', actions: 'begin' },
        INCOMING: { target: 'incoming', actions: 'begin' },
      },
    },
  },
})
