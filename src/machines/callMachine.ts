import { assign, setup } from 'xstate'
import type { CallMediaState } from '../wallet/calls/callWire'

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
  /** The other side of a two-person call; on a group call, the host (or, for the host, who it dialled first). */
  peer: string | null
  /** Everyone else asked onto this call, joined or not. */
  members: string[]
  /** Who this side has a live media leg with. */
  joined: string[]
  /** Each member's mute, camera and share, as it last said. */
  remote: Record<string, CallMediaState>
  direction: CallDirection
  video: boolean
  muted: boolean
  remoteMuted: boolean
  /** This side is sending camera video. */
  camera: boolean
  remoteCamera: boolean
  /** This side is sending a screen or window instead of its camera. */
  sharing: boolean
  remoteSharing: boolean
  startedAt: number
  connectedAt: number | null
  endedAt: number | null
  outcome: CallOutcome | null
  /** Why a `failed` call failed, in the user's words. */
  failure: string | null
}

export type CallEvent =
  | { type: 'DIAL'; callId: string; peer: string; video: boolean; at: number }
  | { type: 'INCOMING'; callId: string; peer: string; video: boolean; at: number; members?: string[] }
  | { type: 'MEMBERS'; members: string[] }
  | { type: 'JOINED'; peer: string }
  | { type: 'LEFT'; peer: string }
  | { type: 'REACHED' }
  | { type: 'UNREACHABLE'; at: number }
  | { type: 'ACCEPT'; video: boolean }
  | { type: 'REMOTE_ACCEPTED' }
  | { type: 'DECLINE'; at: number }
  | { type: 'REMOTE_DECLINED'; busy: boolean; at: number }
  | { type: 'MEDIA_CONNECTED'; at: number }
  | { type: 'FAIL'; reason: string; at: number }
  | { type: 'HANG_UP'; at: number }
  | { type: 'REMOTE_HUNG_UP'; at: number }
  | { type: 'TOGGLE_MUTE' }
  | { type: 'CAMERA'; on: boolean }
  | { type: 'SHARE'; on: boolean }
  | { type: 'REMOTE_STATE'; peer: string; muted: boolean; camera: boolean; sharing: boolean }
  | { type: 'DISMISS' }

const blank: CallContext = {
  callId: null,
  peer: null,
  members: [],
  joined: [],
  remote: {},
  direction: 'out',
  video: false,
  muted: false,
  remoteMuted: false,
  camera: false,
  remoteCamera: false,
  sharing: false,
  remoteSharing: false,
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
        members: event.type === 'INCOMING' && event.members?.length ? event.members : [event.peer],
        direction: event.type === 'DIAL' ? ('out' as const) : ('in' as const),
        video: event.video,
        camera: event.type === 'DIAL' && event.video,
        remoteCamera: event.type === 'INCOMING' && event.video,
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
    remoteState: assign(({ context, event }) => {
      if (event.type !== 'REMOTE_STATE') return {}
      const state = { muted: event.muted, camera: event.camera, sharing: event.sharing }
      const remote = { ...context.remote, [event.peer]: state }
      return event.peer === context.peer
        ? { remote, remoteMuted: event.muted, remoteCamera: event.camera, remoteSharing: event.sharing }
        : { remote }
    }),
    members: assign(({ event }) => (event.type === 'MEMBERS' ? { members: event.members } : {})),
    joined: assign(({ context, event }) =>
      event.type === 'JOINED' && !context.joined.includes(event.peer) ? { joined: [...context.joined, event.peer] } : {},
    ),
    left: assign(({ context, event }) => {
      if (event.type !== 'LEFT') return {}
      const { [event.peer]: _gone, ...remote } = context.remote
      return { joined: context.joined.filter((k) => k !== event.peer), remote }
    }),
    camera: assign(({ event }) => (event.type === 'CAMERA' ? { camera: event.on } : {})),
    share: assign(({ event }) => (event.type === 'SHARE' ? { sharing: event.on } : {})),
    acceptWith: assign(({ event }) => (event.type === 'ACCEPT' ? { camera: event.video } : {})),
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
        CAMERA: { actions: 'camera' },
        MEMBERS: { actions: 'members' },
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
        ACCEPT: { target: 'connecting', actions: 'acceptWith' },
        MEMBERS: { actions: 'members' },
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
        CAMERA: { actions: 'camera' },
        SHARE: { actions: 'share' },
        REMOTE_STATE: { actions: 'remoteState' },
        MEMBERS: { actions: 'members' },
        JOINED: { actions: 'joined' },
        LEFT: { actions: 'left' },
      },
    },
    active: {
      on: {
        HANG_UP: { target: 'ended', actions: endAs('finished') },
        REMOTE_HUNG_UP: { target: 'ended', actions: endAs('finished') },
        FAIL: { target: 'ended', actions: endAs('failed') },
        TOGGLE_MUTE: { actions: 'toggleMute' },
        CAMERA: { actions: 'camera' },
        SHARE: { actions: 'share' },
        REMOTE_STATE: { actions: 'remoteState' },
        MEMBERS: { actions: 'members' },
        JOINED: { actions: 'joined' },
        LEFT: { actions: 'left' },
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
