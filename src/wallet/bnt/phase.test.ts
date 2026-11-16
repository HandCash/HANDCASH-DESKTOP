import { describe, expect, it } from 'vitest'
import { iptPhaseOf } from './phase'

const silence = 604_800

describe('BRC-253 §9 beacon phases', () => {
  it('lapses strictly after the silence period, not at its boundary', () => {
    expect(iptPhaseOf([{ minedAt: 100 }], silence, 100 + silence)).toBe('live')
    expect(iptPhaseOf([{ minedAt: 100 }], silence, 101 + silence)).toBe('ended')
  })
  it('never revives after a gap between mined beacons', () => {
    expect(iptPhaseOf([{ minedAt: 100 }, { minedAt: 101 + silence }, { minedAt: 102 + silence }], silence, 102 + silence)).toBe('ended')
  })
  it('does not let a mempool refresh reset the silence clock', () => {
    expect(iptPhaseOf([{ minedAt: 100 }, { minedAt: null }], silence, 101 + silence)).toBe('ended')
    expect(iptPhaseOf([{ minedAt: 100 }, { minedAt: null }], silence, 101)).toBe('live')
  })
  it('ends on verified retirement and releases only on verified mined release', () => {
    expect(iptPhaseOf([{ minedAt: 100, retired: true }], silence, 100)).toBe('ended')
    expect(iptPhaseOf([{ minedAt: 100 }, { minedAt: 101, released: true }], silence, 101)).toBe('released')
    expect(iptPhaseOf([{ minedAt: 100 }, { minedAt: null, released: true }], silence, 101)).toBe('unknown')
  })
  it('fails closed on missing or malformed observations', () => {
    expect(iptPhaseOf([], silence, 100)).toBe('unknown')
    expect(iptPhaseOf([{ minedAt: null }], silence, 100)).toBe('unknown')
    expect(iptPhaseOf([{ minedAt: 101 }], silence, 100)).toBe('unknown')
    expect(iptPhaseOf([{ minedAt: 100 }], silence - 1, 100)).toBe('unknown')
    expect(iptPhaseOf([{ minedAt: 100, released: true }, { minedAt: 101 }], silence, 101)).toBe('unknown')
  })
})
