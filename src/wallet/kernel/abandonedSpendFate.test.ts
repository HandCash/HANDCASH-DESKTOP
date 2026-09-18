import { describe, expect, it } from 'vitest'
import {
  ABANDON_GRACE_MS,
  decideAbandonedSpend,
  type AbandonedSpendFacts,
} from './abandonedSpendFate'

const NOW = 1_800_000_000_000

/** Signed, never handed to a broadcaster, and nothing has moved since. */
function abandoned(over: Partial<AbandonedSpendFacts> = {}): AbandonedSpendFacts {
  return {
    hasArcadeContact: false,
    onChain: false,
    inputs: ['unspent', 'unspent'],
    createdAt: NOW - ABANDON_GRACE_MS - 1,
    now: NOW,
    ...over,
  }
}

describe('abandoned spend fate', () => {
  it('reclaims a signed spend that never reached a broadcaster', () => {
    const fate = decideAbandonedSpend(abandoned())
    expect(fate.kind).toBe('abandoned')
    expect(fate.reason).toContain('never broadcast')
  })

  it('keeps a cheque a broadcaster accepted', () => {
    expect(decideAbandonedSpend(abandoned({ hasArcadeContact: true }))).toMatchObject({
      kind: 'keep',
      reason: 'Arcade-pinned',
    })
  })

  it('keeps anything that is actually on chain', () => {
    expect(decideAbandonedSpend(abandoned({ onChain: true })).kind).toBe('keep')
  })

  it('treats an unanswered explorer as no evidence, not as absence', () => {
    expect(decideAbandonedSpend(abandoned({ onChain: null }))).toMatchObject({
      kind: 'keep',
      reason: 'chain absence unconfirmed',
    })
  })

  it('will not reclaim while any input status is unconfirmed', () => {
    const fate = decideAbandonedSpend(abandoned({ inputs: ['unspent', 'unknown'] }))
    expect(fate).toMatchObject({ kind: 'keep', reason: 'input status unconfirmed' })
  })

  it('leaves a moved input to the competing-spend path', () => {
    const fate = decideAbandonedSpend(abandoned({ inputs: ['unspent', 'spent'] }))
    expect(fate).toMatchObject({ kind: 'keep', reason: 'input already spent elsewhere' })
  })

  it('keeps a spend that is still inside the grace window', () => {
    const young = abandoned({ createdAt: NOW - ABANDON_GRACE_MS + 60_000 })
    expect(decideAbandonedSpend(young)).toMatchObject({
      kind: 'keep',
      reason: 'within grace window',
    })
  })

  it('reads an unknown creation time as brand new', () => {
    expect(decideAbandonedSpend(abandoned({ createdAt: 0 }))).toMatchObject({
      kind: 'keep',
      reason: 'age unknown',
    })
  })

  it('will not reclaim when it cannot see the inputs at all', () => {
    expect(decideAbandonedSpend(abandoned({ inputs: [] }))).toMatchObject({
      kind: 'keep',
      reason: 'inputs unknown',
    })
  })
})

/**
 * The field case: a collectable send whose funding was change from an earlier
 * spend that never landed. The phantom input used to read `unknown` and froze
 * the whole send, sealing four real one-sat items along with it.
 */
describe('chains of unlanded spends', () => {
  it('collapses a spend funded by change that never landed', () => {
    const fate = decideAbandonedSpend(
      abandoned({ inputs: ['phantom', 'unspent', 'unspent', 'unspent', 'unspent'] }),
    )
    expect(fate.kind).toBe('abandoned')
  })

  it('collapses a spend whose every input is phantom', () => {
    const fate = decideAbandonedSpend(abandoned({ inputs: ['phantom'] }))
    expect(fate).toMatchObject({
      kind: 'abandoned',
      reason: 'never broadcast — every input is change from a spend that never landed',
    })
  })

  it('still refuses when a real input moved alongside a phantom one', () => {
    expect(
      decideAbandonedSpend(abandoned({ inputs: ['phantom', 'spent'] })).kind,
    ).toBe('keep')
  })

  it('still refuses while a sibling input is merely unconfirmed', () => {
    expect(
      decideAbandonedSpend(abandoned({ inputs: ['phantom', 'unknown'] })).kind,
    ).toBe('keep')
  })
})
