import { describe, expect, it } from 'vitest'
import {
  BODYLESS_HINT_RETRY_MS,
  UNRESOLVABLE_GRACE_MS,
  decideInboundHintFate,
  isTerminalInboundHintStatus,
  mayBeUnresolvable,
  shouldDeferBodylessHintRetry,
  type InboundHintFacts,
} from './inboundHintFate'

const NOW = 1_800_000_000_000

/** Every fact pointing at "the sender never broadcast this". */
function unbroadcast(over: Partial<InboundHintFacts> = {}): InboundHintFacts {
  return {
    isArcadeGhost: false,
    hasDeliverableBeef: false,
    bodyLookup: 'miss',
    rawBodyCanRecover: true,
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

  it('retires an old item hint when only a raw body exists', () => {
    const fate = decideInboundHintFate(
      unbroadcast({
        bodyLookup: 'hit',
        rawBodyCanRecover: false,
        onChain: true,
      }),
    )
    expect(fate.kind).toBe('unresolvable')
    expect(fate.kind === 'unresolvable' && fate.reason).toContain('AtomicBEEF')
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

  it('defers a recent body-less miss until grace, then allows the retirement probe', () => {
    expect(
      shouldDeferBodylessHintRetry({
        lastFailAt: NOW - 60_000,
        firstSeenAt: NOW - 60_000,
        now: NOW,
      }),
    ).toBe(true)
    expect(
      shouldDeferBodylessHintRetry({
        lastFailAt: NOW - BODYLESS_HINT_RETRY_MS - 1,
        firstSeenAt: NOW - 60_000,
        now: NOW,
      }),
    ).toBe(false)
    expect(
      shouldDeferBodylessHintRetry({
        lastFailAt: NOW - 60_000,
        firstSeenAt: NOW - UNRESOLVABLE_GRACE_MS - 1,
        now: NOW,
      }),
    ).toBe(false)
  })

  it('spends an explorer round-trip only when retirement is actually possible', () => {
    expect(mayBeUnresolvable(unbroadcast())).toBe(true)
    expect(mayBeUnresolvable(unbroadcast({ hasDeliverableBeef: true }))).toBe(false)
    expect(mayBeUnresolvable(unbroadcast({ bodyLookup: 'unknown' }))).toBe(false)
    expect(
      mayBeUnresolvable(
        unbroadcast({ bodyLookup: 'hit', rawBodyCanRecover: false }),
      ),
    ).toBe(true)
    expect(mayBeUnresolvable(unbroadcast({ bodyLookup: 'hit' }))).toBe(false)
    expect(mayBeUnresolvable(unbroadcast({ isArcadeGhost: true }))).toBe(false)
    expect(
      mayBeUnresolvable(unbroadcast({ firstSeenAt: NOW - 60_000 })),
    ).toBe(false)
  })
})

describe('a package that spends a transaction nobody has', () => {
  const PARENT = '6a'.repeat(32)
  /** We hold the body — before this fact existed that alone meant "retry forever". */
  function deadParent(over: Partial<InboundHintFacts> = {}): InboundHintFacts {
    return unbroadcast({
      hasDeliverableBeef: true,
      bodyLookup: 'unknown',
      onChain: null,
      missingAncestor: { txid: PARENT, bodyLookup: 'miss', onChain: false },
      ...over,
    })
  }

  it('retires the hint once the parent is absent at every provider and on chain', () => {
    const fate = decideInboundHintFate(deadParent())
    expect(fate.kind).toBe('unresolvable')
    expect(fate.kind === 'unresolvable' && fate.reason).toContain(PARENT.slice(0, 12))
  })

  it('is worth the probe even though we hold the body', () => {
    const { onChain: _drop, ...facts } = deadParent()
    expect(mayBeUnresolvable(facts)).toBe(true)
  })

  it('keeps retrying while the parent has only been silent', () => {
    expect(
      decideInboundHintFate(
        deadParent({ missingAncestor: { txid: PARENT, bodyLookup: 'unknown', onChain: null } }),
      ).kind,
    ).toBe('retry')
    expect(
      decideInboundHintFate(
        deadParent({ missingAncestor: { txid: PARENT, bodyLookup: 'miss', onChain: null } }),
      ).kind,
    ).toBe('retry')
  })

  it('keeps retrying when the parent turns out to exist — the package may complete next pass', () => {
    expect(
      decideInboundHintFate(
        deadParent({ missingAncestor: { txid: PARENT, bodyLookup: 'hit', onChain: true } }),
      ).kind,
    ).toBe('retry')
  })

  it('holds a young hint through the grace window', () => {
    expect(
      decideInboundHintFate(deadParent({ firstSeenAt: NOW - UNRESOLVABLE_GRACE_MS + 1 })).kind,
    ).toBe('retry')
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
