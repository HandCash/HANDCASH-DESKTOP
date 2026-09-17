import { describe, expect, it } from 'vitest'
import {
  UNRESOLVABLE_GRACE_MS,
  decideInboundHintFate,
  isTerminalInboundHintStatus,
  mayBeUnresolvable,
  type InboundHintFacts,
} from './inboundHintFate'

const NOW = 1_800_000_000_000

/** Every fact pointing at "the sender never broadcast this". */
function unbroadcast(over: Partial<InboundHintFacts> = {}): InboundHintFacts {
  return {
    isArcadeGhost: false,
    hasDeliverableBeef: false,
    bodyLookup: 'miss',
    onChain: false,
    firstSeenAt: NOW - UNRESOLVABLE_GRACE_MS - 1,
    now: NOW,
    ...over,
  }
}

describe('inbound hint fate', () => {
  it('retires a hint no provider has and no explorer can see', () => {
    const fate = decideInboundHintFate(unbroadcast())
    expect(fate.kind).toBe('unresolvable')
    expect(fate.kind === 'unresolvable' && fate.reason).toContain('never broadcast')
  })

  it('ACKs an Arcade hard-reject away before anything else', () => {
    expect(decideInboundHintFate(unbroadcast({ isArcadeGhost: true })).kind).toBe(
      'arcadeGhost',
    )
  })

  it('keeps chasing while we still hold a body we could broadcast', () => {
    expect(decideInboundHintFate(unbroadcast({ hasDeliverableBeef: true })).kind).toBe(
      'retry',
    )
  })

  it('keeps chasing when the providers were never all asked', () => {
    expect(decideInboundHintFate(unbroadcast({ bodyLookup: 'unknown' })).kind).toBe('retry')
    expect(decideInboundHintFate(unbroadcast({ bodyLookup: 'hit' })).kind).toBe('retry')
  })

  it('treats an unanswered explorer as no evidence, not as absence', () => {
    expect(decideInboundHintFate(unbroadcast({ onChain: null })).kind).toBe('retry')
  })

  it('never retires a hint that is on chain', () => {
    expect(decideInboundHintFate(unbroadcast({ onChain: true })).kind).toBe('retry')
  })

  it('holds a young hint through the grace window', () => {
    const young = unbroadcast({ firstSeenAt: NOW - UNRESOLVABLE_GRACE_MS + 60_000 })
    expect(decideInboundHintFate(young).kind).toBe('retry')
  })

  it('reads an unknown arrival time as brand new', () => {
    expect(decideInboundHintFate(unbroadcast({ firstSeenAt: 0 })).kind).toBe('retry')
  })

  it('spends an explorer round-trip only when retirement is actually possible', () => {
    expect(mayBeUnresolvable(unbroadcast())).toBe(true)
    expect(mayBeUnresolvable(unbroadcast({ hasDeliverableBeef: true }))).toBe(false)
    expect(mayBeUnresolvable(unbroadcast({ bodyLookup: 'unknown' }))).toBe(false)
    expect(mayBeUnresolvable(unbroadcast({ isArcadeGhost: true }))).toBe(false)
    expect(
      mayBeUnresolvable(unbroadcast({ firstSeenAt: NOW - 60_000 })),
    ).toBe(false)
  })
})

describe('terminal hint status', () => {
  it('takes received and retired cards out of the sweep', () => {
    expect(isTerminalInboundHintStatus('Received')).toBe(true)
    expect(isTerminalInboundHintStatus('unavailable')).toBe(true)
    expect(isTerminalInboundHintStatus('Unavailable — sender never broadcast')).toBe(true)
  })

  it('leaves in-flight cards in the sweep', () => {
    expect(isTerminalInboundHintStatus('Receiving (SPV)')).toBe(false)
    expect(isTerminalInboundHintStatus('Verifying on chain…')).toBe(false)
    expect(isTerminalInboundHintStatus(undefined)).toBe(false)
    expect(isTerminalInboundHintStatus('')).toBe(false)
  })
})
