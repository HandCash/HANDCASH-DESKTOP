import { describe, expect, it } from 'vitest'
import { batchCountLabel } from './batchCountLabel'

describe('batchCountLabel', () => {
  it('shows counts under a thousand exactly', () => {
    expect(batchCountLabel(2)).toBe('2')
    expect(batchCountLabel(57)).toBe('57')
    expect(batchCountLabel(999)).toBe('999')
  })

  it('shows thousands with a k, one decimal below 10k', () => {
    expect(batchCountLabel(1_000)).toBe('1k')
    expect(batchCountLabel(1_250)).toBe('1.2k')
    expect(batchCountLabel(9_999)).toBe('9.9k')
    expect(batchCountLabel(10_000)).toBe('10k')
    expect(batchCountLabel(217_900)).toBe('217k')
  })

  it('never rounds up past what the batch holds', () => {
    expect(batchCountLabel(1_999)).toBe('1.9k')
    expect(batchCountLabel(19_999)).toBe('19k')
  })
})
