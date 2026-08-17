import { describe, expect, it } from 'vitest'
import {
  chooseLegacySweepPath,
  isSweepableFunding,
  MIN_SWEEPABLE_SATS,
} from './legacySweepPath'

describe('chooseLegacySweepPath', () => {
  it('holds 1-sat as a possible ordinal tip', () => {
    expect(chooseLegacySweepPath({ satoshis: 1 })).toEqual({
      path: 'hold',
      reason: 'oneSat',
    })
  })

  it('holds companion dust below the sweep floor', () => {
    expect(chooseLegacySweepPath({ satoshis: 2 })).toEqual({
      path: 'hold',
      reason: 'uneconomical',
    })
    expect(chooseLegacySweepPath({ satoshis: MIN_SWEEPABLE_SATS - 1 })).toEqual({
      path: 'hold',
      reason: 'uneconomical',
    })
  })

  it('sweeps only when the output can pay its own fee', () => {
    expect(chooseLegacySweepPath({ satoshis: MIN_SWEEPABLE_SATS })).toEqual({
      path: 'sweep',
    })
    expect(chooseLegacySweepPath({ satoshis: 60 })).toEqual({ path: 'sweep' })
  })

  it('holds non-positive amounts closed', () => {
    expect(chooseLegacySweepPath({ satoshis: 0 })).toEqual({
      path: 'hold',
      reason: 'nonPositive',
    })
    expect(chooseLegacySweepPath({ satoshis: -1 })).toEqual({
      path: 'hold',
      reason: 'nonPositive',
    })
  })

  it('exposes isSweepableFunding as the boolean form of path === sweep', () => {
    expect(isSweepableFunding({ satoshis: 1 })).toBe(false)
    expect(isSweepableFunding({ satoshis: 2 })).toBe(false)
    expect(isSweepableFunding({ satoshis: MIN_SWEEPABLE_SATS })).toBe(true)
  })
})
