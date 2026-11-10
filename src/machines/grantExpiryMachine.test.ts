import { createActor } from 'xstate'
import { describe, expect, it } from 'vitest'
import { GRANT_EXPIRING_SOON_MS, grantExpiryMachine } from './grantExpiryMachine'

const start = (expiresAt: number | null, now = 1000) =>
  createActor(grantExpiryMachine, { input: { expiresAt, now } }).start()

describe('grantExpiry chart', () => {
  it('never lapses without an expiry', () => {
    const a = start(null)
    a.send({ type: 'TICK', now: 9e15 })
    expect(a.getSnapshot().value).toBe('active')
  })
  it('goes active → expiring → expired as time passes', () => {
    const exp = 1000 + 3 * GRANT_EXPIRING_SOON_MS
    const a = start(exp)
    expect(a.getSnapshot().value).toBe('active')
    a.send({ type: 'TICK', now: exp - 1000 })
    expect(a.getSnapshot().value).toBe('expiring')
    a.send({ type: 'TICK', now: exp })
    expect(a.getSnapshot().value).toBe('expired')
  })
  it('extending an expiring grant returns it to active', () => {
    const a = start(2000)
    expect(a.getSnapshot().value).toBe('expiring')
    a.send({ type: 'SET_EXPIRY', expiresAt: 1000 + 5 * GRANT_EXPIRING_SOON_MS, now: 1000 })
    expect(a.getSnapshot().value).toBe('active')
  })
  it('revoke ends it from any state and expired cannot be extended', () => {
    const r = start(2000)
    r.send({ type: 'REVOKE' })
    expect(r.getSnapshot().value).toBe('revoked')
    const e = start(500)
    expect(e.getSnapshot().value).toBe('expired')
    e.send({ type: 'SET_EXPIRY', expiresAt: 9e12, now: 1000 })
    expect(e.getSnapshot().value).toBe('expired')
  })
})
