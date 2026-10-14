import { describe, expect, it } from 'vitest'
import { PrivateKey } from '@bsv/sdk'
import {
  REQUEST_MAX_AGE_MS,
  decideRequestAnswer,
  parseHoldingMessage,
  releaseAcceptPreimage,
  releaseRequestPreimage,
  signReleaseAccept,
  signReleaseRequest,
} from './accountRelease'

const root = PrivateKey.fromRandom().toHex()
const identityKey = PrivateKey.fromHex(root).toPublicKey().toString().toLowerCase()
const NOW = 1_800_000_000_000

describe('BRC-249 release messages', () => {
  it('signs over the exact preimage the draft names', () => {
    const request = signReleaseRequest(root, { deviceId: 'phone', seq: 4, nonce: 'a'.repeat(32), at: NOW })
    expect(releaseRequestPreimage(request)).toBe(
      ['account-release-request', 'v1', identityKey, 'phone', '4', 'a'.repeat(32), String(NOW)].join('\n'),
    )
    const accept = signReleaseAccept(root, { deviceId: 'laptop', nonce: 'a'.repeat(32), at: NOW })
    expect(releaseAcceptPreimage(accept)).toBe(
      ['account-release-accept', 'v1', identityKey, 'laptop', 'a'.repeat(32), String(NOW)].join('\n'),
    )
  })

  it('round-trips through the box and refuses anything altered or foreign', () => {
    const request = signReleaseRequest(root, { deviceId: 'phone', seq: 2 })
    expect(request.nonce).toMatch(/^[0-9a-f]{32}$/)
    expect(parseHoldingMessage(JSON.stringify(request), identityKey)).toEqual(request)
    expect(parseHoldingMessage(JSON.stringify({ ...request, seq: 3 }), identityKey)).toBeNull()
    expect(parseHoldingMessage(JSON.stringify({ ...request, deviceId: 'thief' }), identityKey)).toBeNull()

    const other = PrivateKey.fromRandom().toHex()
    const foreign = signReleaseRequest(other, { deviceId: 'phone', seq: 2 })
    expect(parseHoldingMessage(JSON.stringify(foreign), identityKey)).toBeNull()

    const accept = signReleaseAccept(root, { deviceId: 'laptop', nonce: request.nonce })
    expect(parseHoldingMessage(JSON.stringify(accept), identityKey)).toEqual(accept)
    expect(parseHoldingMessage('not json', identityKey)).toBeNull()
    expect(parseHoldingMessage(JSON.stringify({ ...accept, type: 'release-maybe' }), identityKey)).toBeNull()
  })
})

describe('a holder answering a release request', () => {
  const request = (seq: number, at = NOW) => signReleaseRequest(root, { deviceId: 'phone', seq, at })

  it('accepts a fresh request for the seq it holds, without asking', () => {
    expect(decideRequestAnswer({ request: request(3), local: { kind: 'here', seq: 3 }, now: NOW })).toEqual({
      kind: 'accept',
    })
    expect(decideRequestAnswer({ request: request(0), local: { kind: 'here', seq: 0 }, now: NOW }).kind).toBe('accept')
  })

  it('drops a request a later move overtook, or one older than ten minutes', () => {
    expect(decideRequestAnswer({ request: request(2), local: { kind: 'here', seq: 3 }, now: NOW })).toEqual({
      kind: 'drop',
      reason: 'overtaken',
    })
    expect(
      decideRequestAnswer({ request: request(3, NOW - REQUEST_MAX_AGE_MS - 1), local: { kind: 'here', seq: 3 }, now: NOW }),
    ).toEqual({ kind: 'drop', reason: 'expired' })
  })

  it('leaves requests that are not its to consume', () => {
    expect(
      decideRequestAnswer({ request: request(3), local: { kind: 'elsewhere', seq: 3, deviceId: 'x' }, now: NOW }),
    ).toEqual({ kind: 'leave', reason: 'not-holder' })
    expect(decideRequestAnswer({ request: request(5), local: { kind: 'here', seq: 3 }, now: NOW })).toEqual({
      kind: 'leave',
      reason: 'newer-record',
    })
  })
})
