import { describe, expect, it } from 'vitest'
import {
  estimateConsolidationFeeSats,
  MIN_FRAGMENTS_TO_CONSOLIDATE,
  MIN_NET_AFTER_FEE_SATS,
  planChangeConsolidation,
} from './changeConsolidationPath'

describe('planChangeConsolidation', () => {
  it('skips when the pool is not fragmented enough', () => {
    const plan = planChangeConsolidation({
      fragments: MIN_FRAGMENTS_TO_CONSOLIDATE - 1,
      totalSats: 10_000_000,
    })
    expect(plan).toEqual({
      action: 'skip',
      reason: 'tooFewFragments',
      fragments: MIN_FRAGMENTS_TO_CONSOLIDATE - 1,
      totalSats: 10_000_000,
    })
  })

  it('skips when the fragments cannot cover the fee plus a worthwhile remainder', () => {
    const fragments = MIN_FRAGMENTS_TO_CONSOLIDATE
    const estFee = estimateConsolidationFeeSats(fragments)
    const plan = planChangeConsolidation({
      fragments,
      totalSats: estFee + MIN_NET_AFTER_FEE_SATS, // exactly the floor → skip
    })
    expect(plan.action).toBe('skip')
    if (plan.action === 'skip') expect(plan.reason).toBe('belowFeeFloor')
  })

  it('consolidates once the pool is fragmented and comfortably above the fee', () => {
    const fragments = MIN_FRAGMENTS_TO_CONSOLIDATE
    const estFee = estimateConsolidationFeeSats(fragments)
    const totalSats = estFee + MIN_NET_AFTER_FEE_SATS + 1
    const plan = planChangeConsolidation({ fragments, totalSats })
    expect(plan).toEqual({
      action: 'consolidate',
      fragments,
      totalSats,
      estFeeSats: estFee,
    })
  })

  it('fee estimate grows with input count', () => {
    expect(estimateConsolidationFeeSats(100)).toBeGreaterThan(
      estimateConsolidationFeeSats(30),
    )
  })

  it('normalizes junk input to a closed skip rather than throwing', () => {
    const plan = planChangeConsolidation({
      fragments: Number.NaN,
      totalSats: Number.NaN,
    })
    expect(plan).toEqual({
      action: 'skip',
      reason: 'tooFewFragments',
      fragments: 0,
      totalSats: 0,
    })
  })
})
