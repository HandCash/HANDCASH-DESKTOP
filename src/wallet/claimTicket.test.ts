import { describe, expect, it } from 'vitest'
import { mintClaimTicket, verifyClaimTicket } from './claimTicket'
import { parseHandleInput } from './handleResolve'

const SECRET = 'test-handle-claim-secret'

describe('claimTicket', () => {
  it('round-trips a ticket bound to handle + identity', async () => {
    const identityKey =
      '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
    const { ticket, exp } = await mintClaimTicket(SECRET, {
      handle: '$Alice',
      identityKey,
      ttlSec: 120,
    })
    expect(exp).toBeGreaterThan(Math.floor(Date.now() / 1000))

    const ok = await verifyClaimTicket(SECRET, ticket, {
      handle: 'alice',
      identityKey,
    })
    expect(ok.ok).toBe(true)
  })

  it('rejects a ticket for the wrong identity key', async () => {
    const a =
      '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
    const b =
      '03ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    const { ticket } = await mintClaimTicket(SECRET, { handle: 'alice', identityKey: a })
    const bad = await verifyClaimTicket(SECRET, ticket, { handle: 'alice', identityKey: b })
    expect(bad).toEqual({ ok: false, error: 'ticket-identity-mismatch' })
  })

  it('rejects an expired ticket', async () => {
    const identityKey =
      '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
    const { ticket } = await mintClaimTicket(SECRET, {
      handle: 'alice',
      identityKey,
      ttlSec: 1,
    })
    const bad = await verifyClaimTicket(
      SECRET,
      ticket,
      { handle: 'alice', identityKey },
      Math.floor(Date.now() / 1000) + 60,
    )
    expect(bad).toEqual({ ok: false, error: 'ticket-expired' })
  })
})

describe('parseHandleInput $ preference', () => {
  it('parses HandCash $ forms', () => {
    expect(parseHandleInput('$alice')).toEqual({ handle: 'alice', domain: null })
    expect(parseHandleInput('$alice@handcash.io')).toEqual({
      handle: 'alice',
      domain: 'handcash.io',
    })
  })

  it('still accepts BRC-169 @ forms', () => {
    expect(parseHandleInput('@alice')).toEqual({ handle: 'alice', domain: null })
    expect(parseHandleInput('@alice@handcash.io')).toEqual({
      handle: 'alice',
      domain: 'handcash.io',
    })
  })
})
