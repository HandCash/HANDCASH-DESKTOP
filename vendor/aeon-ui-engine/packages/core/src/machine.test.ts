import { describe, expect, it } from 'vitest'
import {
  fieldFace,
  fieldRegions,
  getRegionValue,
  regionLeaf,
  regionMatches,
  regionPath,
  stateToAttr,
} from './machine.js'

describe('stateToAttr', () => {
  it('stringifies string states', () => {
    expect(stateToAttr('open')).toBe('open')
  })

  it('flattens parallel regions', () => {
    expect(
      stateToAttr({
        interaction: 'dirty',
        validation: 'invalid',
        submission: 'idle',
      }),
    ).toBe('interaction:dirty validation:invalid submission:idle')
  })
})

describe('fieldFace', () => {
  it('projects a single leaf face (pending > invalid > dirty > idle)', () => {
    expect(fieldFace({ interaction: 'pristine', validation: 'valid', submission: 'idle' })).toBe(
      'idle',
    )
    expect(fieldFace({ interaction: 'dirty', validation: 'valid', submission: 'idle' })).toBe(
      'dirty',
    )
    expect(fieldFace({ interaction: 'dirty', validation: 'invalid', submission: 'idle' })).toBe(
      'invalid',
    )
    expect(fieldFace({ interaction: 'dirty', validation: 'valid', submission: 'pending' })).toBe(
      'pending',
    )
  })

  it('exposes orthogonal regions separately', () => {
    expect(
      fieldRegions({ interaction: 'dirty', validation: 'invalid', submission: 'idle' }),
    ).toEqual({
      interaction: 'dirty',
      validation: 'invalid',
      submission: 'idle',
    })
  })
})

describe('region helpers', () => {
  const value = {
    session: { authenticating: 'verifyCode' },
    route: 'discover',
    deck: { ready: 'matched' },
  }

  it('reads a region value', () => {
    expect(getRegionValue(value, 'route')).toBe('discover')
    expect(getRegionValue(value, 'deck')).toEqual({ ready: 'matched' })
  })

  it('walks compound paths to a leaf', () => {
    expect(regionPath(value, 'deck')).toEqual(['ready', 'matched'])
    expect(regionLeaf(value, 'deck')).toBe('matched')
    expect(regionLeaf(value, 'session')).toBe('verifyCode')
    expect(regionLeaf(value, 'route')).toBe('discover')
  })

  it('matches leaves and path prefixes', () => {
    expect(regionMatches(value, 'deck', 'matched')).toBe(true)
    expect(regionMatches(value, 'deck', ['ready', 'matched'])).toBe(true)
    expect(regionMatches(value, 'deck', 'loading')).toBe(false)
  })
})
