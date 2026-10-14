import { beforeEach, describe, expect, it } from 'vitest'
import {
  HOLDING_GAP_MS,
  isHoldingFresh,
  noteHoldingChecked,
  noteHoldingGap,
  noteHoldingServed,
  resetHoldingFreshnessForTests,
} from './holdingFreshness'

const A = '02' + 'a'.repeat(64)
const B = '03' + 'b'.repeat(64)

beforeEach(() => resetHoldingFreshnessForTests())

describe('holding freshness (one check per gap)', () => {
  it('starts stale: the first spend after start checks', () => {
    noteHoldingServed(1_000)
    expect(isHoldingFresh(A, 1_000)).toBe(false)
  })

  it('is fresh after a check while the holding channel keeps being served', () => {
    noteHoldingServed(1_000)
    noteHoldingChecked(A, 1_000)
    expect(isHoldingFresh(A, 2_000)).toBe(true)
    noteHoldingServed(6_000)
    noteHoldingServed(11_000)
    expect(isHoldingFresh(A, 12_000)).toBe(true)
    expect(isHoldingFresh(B, 12_000)).toBe(false)
  })

  it('a pause in serving longer than the gap allowance makes it stale, even before the next tick', () => {
    noteHoldingServed(1_000)
    noteHoldingChecked(A, 1_000)
    expect(isHoldingFresh(A, 1_000 + HOLDING_GAP_MS + 1)).toBe(false)
    noteHoldingServed(1_000 + HOLDING_GAP_MS + 1)
    expect(isHoldingFresh(A, 1_000 + HOLDING_GAP_MS + 2)).toBe(false)
    noteHoldingChecked(A, 1_000 + HOLDING_GAP_MS + 2)
    expect(isHoldingFresh(A, 1_000 + HOLDING_GAP_MS + 3)).toBe(true)
  })

  it('a reconnect is a gap; a check that began before it does not count', () => {
    noteHoldingServed(1_000)
    noteHoldingChecked(A, 1_000)
    noteHoldingGap(2_000)
    expect(isHoldingFresh(A, 2_001)).toBe(false)
    noteHoldingChecked(A, 1_500)
    expect(isHoldingFresh(A, 2_001)).toBe(false)
    noteHoldingChecked(A, 2_000)
    expect(isHoldingFresh(A, 2_001)).toBe(true)
  })
})
