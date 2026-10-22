/**
 * Call frames (`hc-call/1`). They ride only an open direct session (draft
 * BRC-246): that channel is DTLS between two installs whose identity keys
 * signed its fingerprints, so the sender is the session's peer and nothing
 * here is sealed again. A frame never falls back to the box: a call is live
 * or it is not happening.
 */

export const CALL_PROTOCOL = 'hc-call/1'

const SDP_MAX = 64 * 1024
const CANDIDATE_MAX = 2 * 1024
const CALL_ID = /^[0-9a-f]{24}$/

export type CallDeclineReason = 'declined' | 'busy' | 'missed'
export type CallHangupReason = 'hung-up' | 'cancelled' | 'failed'

export type CallMediaState = {
  muted: boolean
  /** The sender's camera is on and sending. */
  camera: boolean
}

export type CallFrame =
  | { t: 'invite'; call: string; video: boolean }
  | { t: 'accept'; call: string }
  | { t: 'decline'; call: string; reason: CallDeclineReason }
  | { t: 'sdp'; call: string; description: { type: 'offer' | 'answer'; sdp: string } }
  | { t: 'ice'; call: string; candidate: RTCIceCandidateInit }
  | { t: 'state'; call: string; state: CallMediaState }
  | { t: 'hangup'; call: string; reason: CallHangupReason }

export function newCallId(): string {
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('')
}

export function encodeCallFrame(frame: CallFrame): string {
  return JSON.stringify({ p: CALL_PROTOCOL, ...frame })
}

/** Cheap test before parsing: chat bodies are sealed envelopes and never start like this. */
export function isCallFrameBody(body: string): boolean {
  return body.startsWith(`{"p":"${CALL_PROTOCOL}"`)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function parseCandidate(v: unknown): RTCIceCandidateInit | null {
  if (!isRecord(v) || typeof v.candidate !== 'string' || v.candidate.length > CANDIDATE_MAX) return null
  const out: RTCIceCandidateInit = { candidate: v.candidate }
  if (typeof v.sdpMid === 'string' && v.sdpMid.length <= 64) out.sdpMid = v.sdpMid
  if (typeof v.sdpMLineIndex === 'number' && Number.isInteger(v.sdpMLineIndex) && v.sdpMLineIndex >= 0) {
    out.sdpMLineIndex = v.sdpMLineIndex
  }
  if (typeof v.usernameFragment === 'string' && v.usernameFragment.length <= 256) out.usernameFragment = v.usernameFragment
  return out
}

function parseState(v: unknown): CallMediaState | null {
  if (!isRecord(v) || typeof v.muted !== 'boolean') return null
  return { muted: v.muted, camera: v.camera === true }
}

/** A well-formed call frame, or null for anything else (including chat bodies). */
export function parseCallFrame(body: string): CallFrame | null {
  if (!isCallFrameBody(body)) return null
  let v: unknown
  try {
    v = JSON.parse(body)
  } catch {
    return null
  }
  if (!isRecord(v) || v.p !== CALL_PROTOCOL || typeof v.call !== 'string' || !CALL_ID.test(v.call)) return null
  const call = v.call
  switch (v.t) {
    case 'invite':
      return typeof v.video === 'boolean' ? { t: 'invite', call, video: v.video } : null
    case 'accept':
      return { t: 'accept', call }
    case 'decline':
      return v.reason === 'declined' || v.reason === 'busy' || v.reason === 'missed'
        ? { t: 'decline', call, reason: v.reason }
        : null
    case 'sdp': {
      const d = v.description
      if (!isRecord(d) || (d.type !== 'offer' && d.type !== 'answer')) return null
      if (typeof d.sdp !== 'string' || d.sdp.length === 0 || d.sdp.length > SDP_MAX) return null
      return { t: 'sdp', call, description: { type: d.type, sdp: d.sdp } }
    }
    case 'ice': {
      const candidate = parseCandidate(v.candidate)
      return candidate ? { t: 'ice', call, candidate } : null
    }
    case 'state': {
      const state = parseState(v.state)
      return state ? { t: 'state', call, state } : null
    }
    case 'hangup':
      return v.reason === 'hung-up' || v.reason === 'cancelled' || v.reason === 'failed'
        ? { t: 'hangup', call, reason: v.reason }
        : null
    default:
      return null
  }
}
