import { describe, expect, it } from 'vitest'
import { callDurationText, callOutcomeText } from './callHistory'
import { callIceServers, parseRelayUrls } from './callSettings'
import { encodeCallFrame, isCallFrameBody, newCallId, parseCallFrame, type CallFrame } from './callWire'

const call = newCallId()

describe('call frames', () => {
  it('round-trips every frame', () => {
    const frames: CallFrame[] = [
      { t: 'invite', call, video: false },
      { t: 'accept', call },
      { t: 'decline', call, reason: 'busy' },
      { t: 'sdp', call, description: { type: 'offer', sdp: 'v=0\r\n' } },
      { t: 'ice', call, candidate: { candidate: 'candidate:1 1 udp 1 192.0.2.1 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 } },
      { t: 'state', call, state: { muted: true, camera: false } },
      { t: 'state', call, state: { muted: false, camera: true } },
      { t: 'hangup', call, reason: 'hung-up' },
    ]
    for (const frame of frames) {
      const body = encodeCallFrame(frame)
      expect(isCallFrameBody(body)).toBe(true)
      expect(parseCallFrame(body)).toEqual(frame)
    }
  })

  it('refuses chat bodies, bad ids, unknown kinds and oversized descriptions', () => {
    expect(parseCallFrame('{"v":1,"ciphertext":"abc"}')).toBeNull()
    expect(parseCallFrame(JSON.stringify({ p: 'hc-call/1', t: 'accept', call: 'nope' }))).toBeNull()
    expect(parseCallFrame(JSON.stringify({ p: 'hc-call/1', t: 'dance', call }))).toBeNull()
    expect(parseCallFrame(JSON.stringify({ p: 'hc-call/1', t: 'decline', call, reason: 'whatever' }))).toBeNull()
    const huge = { type: 'offer', sdp: 'x'.repeat(70_000) }
    expect(parseCallFrame(JSON.stringify({ p: 'hc-call/1', t: 'sdp', call, description: huge }))).toBeNull()
    expect(parseCallFrame('{"p":"hc-call/1",')).toBeNull()
  })

  it('makes 24-hex call ids', () => {
    expect(newCallId()).toMatch(/^[0-9a-f]{24}$/)
    expect(newCallId()).not.toBe(newCallId())
  })
})

describe('call text', () => {
  it('says how long a call lasted', () => {
    expect(callDurationText(0)).toBe('0:00')
    expect(callDurationText(65_000)).toBe('1:05')
    expect(callDurationText(3_725_000)).toBe('1:02:05')
  })

  it('describes each outcome from the right side', () => {
    const base = { video: false, connectedAt: 0, endedAt: 90_000 }
    expect(callOutcomeText({ ...base, direction: 'out', outcome: 'finished' })).toBe('Outgoing call · 1:30')
    expect(callOutcomeText({ ...base, direction: 'in', outcome: 'missed' })).toBe('Missed call')
    expect(callOutcomeText({ ...base, direction: 'out', outcome: 'declined' })).toBe('Call declined')
    expect(callOutcomeText({ ...base, direction: 'in', outcome: 'declined' })).toBe('Declined call')
    expect(callOutcomeText({ ...base, direction: 'out', outcome: 'unreachable' })).toMatch(/HandCash open/)
  })
})

describe('call relay', () => {
  it('keeps only TURN urls and adds them after STUN', () => {
    expect(parseRelayUrls('turn:relay.example:3478, stun:x  turns:relay.example:5349\nhttps://no')).toEqual([
      'turn:relay.example:3478',
      'turns:relay.example:5349',
    ])
    const servers = callIceServers({ relay: { urls: ['turn:relay.example:3478'], username: 'u', credential: 'c' } })
    expect(servers.at(-1)).toEqual({ urls: ['turn:relay.example:3478'], username: 'u', credential: 'c' })
    expect(callIceServers({ relay: null }).every((s) => String(s.urls).startsWith('stun:'))).toBe(true)
  })
})
