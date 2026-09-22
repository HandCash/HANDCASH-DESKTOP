import { describe, expect, it } from 'vitest'
import { decideArcadePinFate } from './arcadePinFate'

describe('decideArcadePinFate', () => {
  it('voids the pin Arcade itself rejected', () => {
    const fate = decideArcadePinFate({ hasPin: true, verdict: 'rejected' })
    expect(fate.kind).toBe('void')
    expect(fate.reason).toContain('never be mined')
  })

  it('holds an accepted or still-working transaction', () => {
    expect(decideArcadePinFate({ hasPin: true, verdict: 'accepted' }).kind).toBe(
      'binds',
    )
    expect(decideArcadePinFate({ hasPin: true, verdict: 'pending' }).kind).toBe(
      'binds',
    )
  })

  it('fails closed on silence — absence of a verdict is not a cancellation', () => {
    expect(decideArcadePinFate({ hasPin: true, verdict: 'unknown' }).kind).toBe(
      'binds',
    )
  })

  it('binds nothing without a pin', () => {
    expect(decideArcadePinFate({ hasPin: false, verdict: 'unknown' }).kind).toBe(
      'void',
    )
  })
})
